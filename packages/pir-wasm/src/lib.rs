#![allow(clippy::missing_safety_doc)]

use chalametpir_client::{Client, SEED_BYTE_LEN};
use std::cell::RefCell;

const OK: u32 = 0;
const ERR_STATE: u32 = 1;
const ERR_ARGS: u32 = 2;
const ERR_CRYPTO: u32 = 3;
const MAX_BYTES: u32 = 64 * 1024 * 1024;

struct State {
    client: Option<Client>,
    out: Vec<u8>,
    error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        client: None,
        out: Vec::new(),
        error: Vec::new(),
    });
}

fn fail(code: u32, message: impl Into<String>) -> u32 {
    STATE.with(|cell| {
        if let Ok(mut state) = cell.try_borrow_mut() {
            state.error = message.into().into_bytes();
        }
    });
    code
}

fn clear_error() {
    STATE.with(|cell| {
        if let Ok(mut state) = cell.try_borrow_mut() {
            state.error.clear();
        }
    });
}

unsafe fn input<'a>(ptr: u32, len: u32) -> Option<&'a [u8]> {
    if len > MAX_BYTES {
        return None;
    }
    if len == 0 {
        return Some(&[]);
    }
    if ptr == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr as *const u8, len as usize))
}

// ChalametPIR menyerialkan tiga field filter sebagai `usize`, sehingga server
// x86_64 menghasilkan 68 byte sementara wasm32 mengharapkan 56 byte. Normalisasi
// ini hanya mengambil low 32-bit (nilai direktori selalu < 2^32) dan menolak
// field yang tidak muat, bukan menebak silang arsitektur.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn portable_filter(filter: &[u8]) -> Result<Vec<u8>, String> {
    if filter.len() == 56 {
        return Ok(filter.to_vec());
    }
    if filter.len() != 68 {
        return Err("panjang filter tidak dikenal".to_string());
    }
    let mut out = Vec::with_capacity(56);
    out.extend_from_slice(&filter[..44]);
    for offset in [44usize, 52, 60] {
        let high = &filter[offset + 4..offset + 8];
        if high != [0, 0, 0, 0] {
            return Err("field filter melebihi u32".to_string());
        }
        out.extend_from_slice(&filter[offset..offset + 4]);
    }
    Ok(out)
}

fn client_filter(filter: &[u8]) -> Result<Vec<u8>, (u32, String)> {
    #[cfg(target_arch = "wasm32")]
    {
        return portable_filter(filter).map_err(|message| (ERR_CRYPTO, message));
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Ok(filter.to_vec())
    }
}

fn setup_impl(seed: &[u8], hint: &[u8], filter: &[u8]) -> Result<(), (u32, String)> {
    if seed.len() != SEED_BYTE_LEN {
        return Err((ERR_ARGS, "seed harus 32 byte".to_string()));
    }
    if hint.is_empty() || filter.is_empty() {
        return Err((ERR_ARGS, "hint/filter kosong".to_string()));
    }
    if hint.len() > MAX_BYTES as usize || filter.len() > MAX_BYTES as usize {
        return Err((ERR_ARGS, "hint/filter terlalu besar".to_string()));
    }
    let seed: &[u8; SEED_BYTE_LEN] = seed
        .try_into()
        .map_err(|_| (ERR_ARGS, "seed tidak valid".to_string()))?;
    let filter = client_filter(filter)?;
    let client =
        Client::setup(seed, hint, &filter).map_err(|error| (ERR_CRYPTO, error.to_string()))?;
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        state.client = Some(client);
        state.out.clear();
        state.error.clear();
    });
    Ok(())
}

fn query_impl(oprf: &[u8]) -> Result<Vec<u8>, (u32, String)> {
    if oprf.len() != 32 {
        return Err((ERR_ARGS, "OPRF index harus 32 byte".to_string()));
    }
    STATE.with(|cell| {
        let mut state = cell
            .try_borrow_mut()
            .map_err(|_| (ERR_STATE, "state sibuk".to_string()))?;
        let client = state
            .client
            .as_mut()
            .ok_or((ERR_STATE, "client belum di-setup".to_string()))?;
        client
            .query(oprf)
            .map_err(|error| (ERR_CRYPTO, error.to_string()))
    })
}

fn process_impl(oprf: &[u8], response: &[u8]) -> Result<Vec<u8>, (u32, String)> {
    if oprf.len() != 32 {
        return Err((ERR_ARGS, "OPRF index harus 32 byte".to_string()));
    }
    if response.is_empty() {
        return Err((ERR_ARGS, "response kosong".to_string()));
    }
    STATE.with(|cell| {
        let mut state = cell
            .try_borrow_mut()
            .map_err(|_| (ERR_STATE, "state sibuk".to_string()))?;
        let client = state
            .client
            .as_mut()
            .ok_or((ERR_STATE, "client belum di-setup".to_string()))?;
        client
            .process_response(oprf, response)
            .map_err(|error| (ERR_CRYPTO, error.to_string()))
    })
}

fn store_out(value: Vec<u8>) {
    STATE.with(|cell| {
        if let Ok(mut state) = cell.try_borrow_mut() {
            state.out = value;
            state.error.clear();
        }
    });
}

#[no_mangle]
pub extern "C" fn pir_alloc(len: u32) -> u32 {
    if len == 0 || len > MAX_BYTES {
        return 0;
    }
    let mut buffer = Vec::<u8>::with_capacity(len as usize);
    let ptr = buffer.as_mut_ptr() as u32;
    std::mem::forget(buffer);
    ptr
}

#[no_mangle]
pub extern "C" fn pir_free(ptr: u32, len: u32) {
    if ptr == 0 || len == 0 || len > MAX_BYTES {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr as *mut u8, 0, len as usize));
    }
}

#[no_mangle]
pub extern "C" fn pir_setup(
    seed_ptr: u32,
    hint_ptr: u32,
    hint_len: u32,
    filter_ptr: u32,
    filter_len: u32,
) -> u32 {
    let seed = match unsafe { input(seed_ptr, SEED_BYTE_LEN as u32) } {
        Some(value) => value,
        None => return fail(ERR_ARGS, "seed tidak valid"),
    };
    let hint = match unsafe { input(hint_ptr, hint_len) } {
        Some(value) => value,
        None => return fail(ERR_ARGS, "hint tidak valid"),
    };
    let filter = match unsafe { input(filter_ptr, filter_len) } {
        Some(value) => value,
        None => return fail(ERR_ARGS, "filter tidak valid"),
    };
    match setup_impl(seed, hint, filter) {
        Ok(()) => {
            clear_error();
            OK
        }
        Err((code, message)) => fail(code, message),
    }
}

#[no_mangle]
pub extern "C" fn pir_query(oprf_ptr: u32) -> u32 {
    let oprf = match unsafe { input(oprf_ptr, 32) } {
        Some(value) => value,
        None => return fail(ERR_ARGS, "OPRF index tidak valid"),
    };
    match query_impl(oprf) {
        Ok(value) => {
            store_out(value);
            OK
        }
        Err((code, message)) => fail(code, message),
    }
}

#[no_mangle]
pub extern "C" fn pir_process(oprf_ptr: u32, response_ptr: u32, response_len: u32) -> u32 {
    let oprf = match unsafe { input(oprf_ptr, 32) } {
        Some(value) => value,
        None => return fail(ERR_ARGS, "OPRF index tidak valid"),
    };
    let response = match unsafe { input(response_ptr, response_len) } {
        Some(value) => value,
        None => return fail(ERR_ARGS, "response tidak valid"),
    };
    match process_impl(oprf, response) {
        Ok(value) => {
            store_out(value);
            OK
        }
        Err((code, message)) => fail(code, message),
    }
}

#[no_mangle]
pub extern "C" fn pir_out_ptr() -> u32 {
    STATE.with(|cell| cell.borrow().out.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn pir_out_len() -> u32 {
    STATE.with(|cell| cell.borrow().out.len() as u32)
}

#[no_mangle]
pub extern "C" fn pir_error_ptr() -> u32 {
    STATE.with(|cell| cell.borrow().error.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn pir_error_len() -> u32 {
    STATE.with(|cell| cell.borrow().error.len() as u32)
}

#[no_mangle]
pub extern "C" fn pir_clear() {
    STATE.with(|cell| {
        if let Ok(mut state) = cell.try_borrow_mut() {
            state.client = None;
            state.out.clear();
            state.error.clear();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chalametpir_server::Server;
    use std::collections::HashMap;

    fn fixture() -> (Server, Vec<u8>, Vec<u8>, Vec<([u8; 32], Vec<u8>)>) {
        let seed = [7u8; SEED_BYTE_LEN];
        let entries: Vec<([u8; 32], Vec<u8>)> = (0..8)
            .map(|index| {
                let mut oprf = [0u8; 32];
                oprf.fill(index as u8 + 1);
                (oprf, vec![index as u8 + 1; 256])
            })
            .collect();
        let db: HashMap<&[u8], &[u8]> = entries
            .iter()
            .map(|(oprf, value)| (oprf.as_slice(), value.as_slice()))
            .collect();
        let (server, hint, filter) = Server::setup::<3>(&seed, db).expect("server setup");
        (server, hint, filter, entries)
    }

    #[test]
    fn abi_roundtrip() {
        let (server, hint, filter, entries) = fixture();
        let seed = [7u8; SEED_BYTE_LEN];
        pir_clear();
        setup_impl(&seed, &hint, &filter).expect("setup");
        let (oprf, expected) = &entries[6];
        let query = query_impl(oprf).expect("query");
        let response = server.respond(&query).expect("respond");
        let value = process_impl(oprf, &response).expect("process");
        assert_eq!(&value, expected);
    }

    #[test]
    fn portable_filter_drops_high_64bit_words() {
        let mut filter = vec![0u8; 68];
        filter[..32].fill(7);
        filter[32..36].copy_from_slice(&3u32.to_le_bytes());
        filter[36..40].copy_from_slice(&8u32.to_le_bytes());
        filter[40..44].copy_from_slice(&8u32.to_le_bytes());
        filter[44..52].copy_from_slice(&24u64.to_le_bytes());
        filter[52..60].copy_from_slice(&8u64.to_le_bytes());
        filter[60..68].copy_from_slice(&14u64.to_le_bytes());
        let portable = portable_filter(&filter).expect("filter portabel");
        assert_eq!(portable.len(), 56);
        assert_eq!(&portable[..44], &filter[..44]);
        assert_eq!(&portable[44..48], &24u32.to_le_bytes());
        assert_eq!(&portable[48..52], &8u32.to_le_bytes());
        assert_eq!(&portable[52..56], &14u32.to_le_bytes());
    }

    #[test]
    fn portable_filter_rejects_overflow() {
        let mut filter = vec![0u8; 68];
        filter[51] = 1;
        assert!(portable_filter(&filter).is_err());
    }

    #[test]
    fn rejects_bad_input_before_setup() {
        pir_clear();
        assert_eq!(query_impl(&[0u8; 31]).unwrap_err().0, ERR_ARGS);
        assert_eq!(query_impl(&[0u8; 32]).unwrap_err().0, ERR_STATE);
        assert_eq!(process_impl(&[0u8; 32], &[]).unwrap_err().0, ERR_ARGS);
    }
}
