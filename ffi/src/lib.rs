//! C ABI for pdf-inspector-he: the invoice layer behind ONE call, JSON in
//! and out, for Dart (`dart:ffi`), Kotlin (JNI) or Swift.
//!
//! ```c
//! char *pdfhe_call(const char *method, const char *request,
//!                  const uint8_t *bytes, size_t len);
//! void  pdfhe_free(char *result);
//! uint32_t pdfhe_abi_version(void);
//! ```
//!
//! `pdfhe_call` returns a UTF-8 JSON string, `{"ok":true,"result":…}` or
//! `{"ok":false,"error":"…"}`, owned by the library: pass it to
//! `pdfhe_free` exactly once. Methods and requests:
//! `pdf_inspector::invoice::api`. A null `request` is `{}`; `bytes` may be
//! null when `len` is 0. Calls are independent and may run on any thread
//! (one at a time per thread; the read itself is CPU-bound).
use std::ffi::{c_char, CStr, CString};

/// Bumped when a signature above changes (not when methods are added).
pub const ABI_VERSION: u32 = 1;

fn text(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    // SAFETY: the caller passes a NUL-terminated string (documented contract).
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| "argument is not UTF-8".to_string())
}

fn respond(value: serde_json::Value) -> *mut c_char {
    // serde_json escapes NUL, so the JSON never contains an interior NUL.
    CString::new(value.to_string())
        .unwrap_or_default()
        .into_raw()
}

fn error(message: &str) -> *mut c_char {
    respond(serde_json::json!({ "ok": false, "error": message }))
}

/// # Safety
/// `method` and `request` are NUL-terminated UTF-8 or null; `bytes` points
/// to `len` readable bytes (or is null with `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn pdfhe_call(
    method: *const c_char,
    request: *const c_char,
    bytes: *const u8,
    len: usize,
) -> *mut c_char {
    let outcome = std::panic::catch_unwind(|| {
        let method = match text(method) {
            Ok(m) if !m.is_empty() => m,
            Ok(_) => return error("method is required"),
            Err(e) => return error(&e),
        };
        let request = match text(request) {
            Ok(r) => r,
            Err(e) => return error(&e),
        };
        let data: &[u8] = if bytes.is_null() || len == 0 {
            &[]
        } else {
            // SAFETY: documented contract: `len` readable bytes at `bytes`.
            unsafe { std::slice::from_raw_parts(bytes, len) }
        };
        respond(pdf_inspector::invoice::api::call(&method, &request, data))
    });
    outcome.unwrap_or_else(|_| error("internal error"))
}

/// # Safety
/// `result` was returned by [`pdfhe_call`] and is freed once; null is ignored.
#[no_mangle]
pub unsafe extern "C" fn pdfhe_free(result: *mut c_char) {
    if !result.is_null() {
        // SAFETY: allocated by CString::into_raw in `respond`.
        drop(unsafe { CString::from_raw(result) });
    }
}

#[no_mangle]
pub extern "C" fn pdfhe_abi_version() -> u32 {
    ABI_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn call(method: &str, request: &str, bytes: &[u8]) -> serde_json::Value {
        let m = CString::new(method).unwrap();
        let r = CString::new(request).unwrap();
        // SAFETY: valid strings and slice; the result is freed below.
        unsafe {
            let out = pdfhe_call(m.as_ptr(), r.as_ptr(), bytes.as_ptr(), bytes.len());
            let value = serde_json::from_str(CStr::from_ptr(out).to_str().unwrap()).unwrap();
            pdfhe_free(out);
            value
        }
    }

    #[test]
    fn reads_an_invoice_through_the_c_abi() {
        let pdf = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../he/fixtures/invoices/priority-1p.pdf"),
        )
        .unwrap();
        let out = call("read_invoice", "{}", &pdf);
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["result"]["document"]["status"], "ok");
        assert_eq!(
            out["result"]["document"]["lines"].as_array().unwrap().len(),
            15
        );
    }

    #[test]
    fn null_and_bad_arguments_are_errors_not_crashes() {
        // SAFETY: nulls are part of the contract.
        unsafe {
            let out = pdfhe_call(std::ptr::null(), std::ptr::null(), std::ptr::null(), 0);
            assert!(CStr::from_ptr(out)
                .to_str()
                .unwrap()
                .contains("method is required"));
            pdfhe_free(out);
            pdfhe_free(std::ptr::null_mut());
        }
        assert_eq!(call("read_invoice", "{}", b"")["ok"], false);
        assert_eq!(call("version", "", b"")["ok"], true);
        assert_eq!(pdfhe_abi_version(), ABI_VERSION);
    }
}
