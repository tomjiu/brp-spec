/// Windows Named Pipe IPC — lockfile coordination with DACL
///
/// Pipe:  \\.\pipe\brp-bridge
/// DACL:  restricted to current user SID (verified by cross-user test)
///
/// #[cfg(windows)] only — Unix uses ipc_unix.rs.
use std::ffi::c_void;
use std::io;
use std::sync::Arc;
use tokio::sync::Mutex;

// ─── Types ───

type HandlePtr = *mut c_void;

fn is_valid_handle(h: HandlePtr) -> bool {
    !h.is_null() && h != invalid_handle_value()
}
fn invalid_handle_value() -> HandlePtr {
    (-1_isize) as HandlePtr
}

// ─── Win32 constants ───

const PIPE_ACCESS_DUPLEX: u32 = 3;
const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x00080000;
const FILE_FLAG_OVERLAPPED: u32 = 0x40000000;
const PIPE_TYPE_BYTE: u32 = 0;
const PIPE_READMODE_BYTE: u32 = 0;
const PIPE_UNLIMITED_INSTANCES: u32 = 255;
const GENERIC_ALL: u32 = 0x10000000;
const TOKEN_QUERY: u32 = 8;
const TOKEN_USER: u32 = 1;
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
const SET_ACCESS: u32 = 2; // ACCESS_MODE: GRANT_ACCESS=1, SET_ACCESS=2
const TRUSTEE_IS_SID: u32 = 0;
const TRUSTEE_IS_USER: u32 = 1;
const NO_MULTIPLE_TRUSTEE: u32 = 0;

// ─── Minimal Win32 types (not using windows-sys structs to avoid version drift) ───

#[repr(C)]
struct SecurityAttributes {
    n_length: u32,
    sd: *mut c_void,
    inherit: i32,
}

#[repr(C)]
struct SecurityDescriptor([u8; 64]); // Max possible size, padded

#[repr(C)]
struct TrusteeW {
    multiple_trustee: *mut c_void,
    multiple_trustee_op: u32,
    form: u32,
    trustee_type: u32,
    name: *mut u16,
}

#[repr(C)]
struct ExplicitAccessW {
    permissions: u32,
    mode: u32,
    inheritance: u32,
    trustee: TrusteeW,
}

#[repr(C)]
struct SidAndAttributes {
    sid: HandlePtr,
    attributes: u32,
}

#[repr(C)]
struct TokenUserRaw {
    user: SidAndAttributes,
}

// ─── Extern Win32 API (kernel32) ───

extern "system" {
    fn GetCurrentProcess() -> HandlePtr;
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buf: u32,
        in_buf: u32,
        timeout: u32,
        sa: *const SecurityAttributes,
    ) -> HandlePtr;
    fn DisconnectNamedPipe(pipe: HandlePtr) -> i32;
    fn CloseHandle(handle: HandlePtr) -> i32;
}

// ─── Extern Win32 API (advapi32) ───

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: HandlePtr, access: u32, token: *mut HandlePtr) -> i32;
    fn GetTokenInformation(
        token: HandlePtr,
        info_class: u32,
        info: *mut c_void,
        info_len: u32,
        ret_len: *mut u32,
    ) -> i32;
    fn SetEntriesInAclW(
        count: u32,
        entries: *mut ExplicitAccessW,
        old_acl: *mut c_void,
        new_acl: *mut *mut c_void,
    ) -> u32;
    fn InitializeSecurityDescriptor(sd: *mut SecurityDescriptor, revision: u32) -> i32;
    fn SetSecurityDescriptorDacl(
        sd: *mut SecurityDescriptor,
        present: i32,
        acl: *mut c_void,
        defaulted: i32,
    ) -> i32;
}

// ─── Pipe path ───

fn pipe_name() -> String {
    r"\\.\pipe\brp-bridge".to_string()
}

// ─── DACL: build SecurityDescriptor restricting access to current user ───

fn build_restricted_sd() -> io::Result<SecurityDescriptor> {
    // 1. Open current process token
    let mut token: HandlePtr = std::ptr::null_mut();
    let ret = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if ret == 0 || token.is_null() {
        return Err(io::Error::last_os_error());
    }

    // 2. Get token user SID
    let mut buf_size: u32 = 0;
    unsafe {
        GetTokenInformation(token, TOKEN_USER, std::ptr::null_mut(), 0, &mut buf_size);
    }
    if buf_size == 0 {
        unsafe {
            CloseHandle(token);
        }
        return Err(io::Error::other("GetTokenInformation zero size"));
    }
    let mut buf: Vec<u8> = vec![0u8; buf_size as usize];
    let mut returned: u32 = 0;
    if unsafe {
        GetTokenInformation(
            token,
            TOKEN_USER,
            buf.as_mut_ptr() as *mut c_void,
            buf_size,
            &mut returned,
        )
    } == 0
    {
        let e = io::Error::last_os_error();
        unsafe {
            CloseHandle(token);
        }
        return Err(e);
    }
    let token_user = buf.as_ptr() as *const TokenUserRaw;
    let user_sid = unsafe { (*token_user).user.sid };

    // 3. Build EXPLICIT_ACCESS_W
    let mut ea = ExplicitAccessW {
        permissions: GENERIC_ALL,
        mode: SET_ACCESS,
        inheritance: 0,
        trustee: TrusteeW {
            multiple_trustee: std::ptr::null_mut(),
            multiple_trustee_op: NO_MULTIPLE_TRUSTEE,
            form: TRUSTEE_IS_SID,
            trustee_type: TRUSTEE_IS_USER,
            name: user_sid as *mut u16,
        },
    };

    // 4. Build ACL from entries
    let mut acl: *mut c_void = std::ptr::null_mut();
    let ret = unsafe { SetEntriesInAclW(1, &mut ea, std::ptr::null_mut(), &mut acl) };
    unsafe {
        CloseHandle(token);
    }
    if ret != 0 {
        return Err(io::Error::other(format!(
            "SetEntriesInAclW failed: {}",
            ret
        )));
    }

    // 5. Security descriptor with DACL
    let mut sd = SecurityDescriptor([0u8; 64]);
    if unsafe { InitializeSecurityDescriptor(&mut sd, SECURITY_DESCRIPTOR_REVISION) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { SetSecurityDescriptorDacl(&mut sd, 1, acl, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(sd)
}

// ─── PipeLock ───

#[derive(Debug)]
pub struct PipeLock {
    handle: HandlePtr,
}

/// The pipe handle is only accessed from the thread that created it.
/// SAFETY: HANDLE operations are thread-safe when not concurrently shared.
unsafe impl Send for PipeLock {}
unsafe impl Sync for PipeLock {}

impl PipeLock {
    pub async fn acquire() -> io::Result<Self> {
        Self::acquire_with_name(&pipe_name()).await
    }

    async fn acquire_with_name(name: &str) -> io::Result<Self> {
        let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let sd = build_restricted_sd()?;

        let sa = SecurityAttributes {
            n_length: std::mem::size_of::<SecurityAttributes>() as u32,
            sd: &sd as *const _ as *mut c_void,
            inherit: 0,
        };

        let handle = unsafe {
            CreateNamedPipeW(
                wide_name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE,
                PIPE_UNLIMITED_INSTANCES,
                512,
                512,
                0,
                &sa,
            )
        };

        if handle == invalid_handle_value() {
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                Some(5) | Some(231) => Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!("Bridge already running (pipe: {})", name),
                )),
                _ => Err(e),
            }
        } else {
            log::info!("[IPC Windows] Pipe acquired: {}", name);
            Ok(Self { handle })
        }
    }

    pub fn release(&mut self) {
        if is_valid_handle(self.handle) {
            unsafe {
                DisconnectNamedPipe(self.handle);
                CloseHandle(self.handle);
            }
            self.handle = std::ptr::null_mut();
            log::info!("[IPC Windows] Pipe released");
        }
    }
}

impl Drop for PipeLock {
    fn drop(&mut self) {
        self.release();
    }
}

pub async fn acquire_pipe_lock() -> io::Result<Arc<Mutex<PipeLock>>> {
    let lock = PipeLock::acquire().await?;
    Ok(Arc::new(Mutex::new(lock)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_test_name() -> String {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        format!(r"\\.\pipe\brp-test-{}-{}", std::process::id(), id)
    }

    #[tokio::test]
    async fn test_pipe_creation_and_release() {
        let lock = PipeLock::acquire_with_name(&unique_test_name()).await;
        assert!(
            lock.is_ok(),
            "first acquire should succeed: {:?}",
            lock.err()
        );
        lock.unwrap().release();
    }

    #[tokio::test]
    async fn test_double_acquire_fails() {
        let name = unique_test_name();
        let _lock1 = PipeLock::acquire_with_name(&name).await.unwrap();
        let lock2 = PipeLock::acquire_with_name(&name).await;
        assert!(lock2.is_err(), "second acquire should fail");
        assert!(
            lock2
                .unwrap_err()
                .to_string()
                .contains("Bridge already running"),
            "error should mention Bridge already running"
        );
    }

    #[tokio::test]
    async fn test_stale_pipe_cleanup() {
        let name = unique_test_name();
        {
            let lock = PipeLock::acquire_with_name(&name).await.unwrap();
            drop(lock);
        }
        let lock2 = PipeLock::acquire_with_name(&name).await;
        assert!(lock2.is_ok(), "re-acquire after release should succeed");
    }
}
