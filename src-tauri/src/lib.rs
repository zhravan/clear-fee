mod db;

use db::{Database, InvoiceDraft, InvoiceTotals};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

struct AppState(Mutex<Database>);

#[tauri::command]
fn calculate_totals(items: Vec<db::LineItem>, discount_basis_points: i64, tax_basis_points: i64) -> Result<InvoiceTotals, String> {
    db::calculate_totals(&items, discount_basis_points, tax_basis_points).map_err(|e| e.to_string())
}

#[tauri::command]
fn next_invoice_number(state: State<'_, AppState>, business_id: String, date: String, prefix: String) -> Result<String, String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .next_invoice_number(&business_id, &date, &prefix).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_invoice(state: State<'_, AppState>, draft: InvoiceDraft) -> Result<String, String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .save_invoice(draft).map_err(|e| e.to_string())
}

#[tauri::command]
fn issue_invoice(state: State<'_, AppState>, invoice_id: String) -> Result<(), String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .issue_invoice(&invoice_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_credit_note(state: State<'_, AppState>, invoice_id: String, number: String, amount_minor: i64, reason: String) -> Result<String, String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .create_credit_note(&invoice_id, &number, amount_minor, &reason).map_err(|e| e.to_string())
}

#[tauri::command]
fn void_invoice(state: State<'_, AppState>, invoice_id: String, reason: String) -> Result<(), String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .void_invoice(&invoice_id, &reason).map_err(|e| e.to_string())
}

#[tauri::command]
fn reverse_payment(state: State<'_, AppState>, payment_id: String, reason: String) -> Result<(), String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .reverse_payment(&payment_id, &reason).map_err(|e| e.to_string())
}

#[tauri::command]
fn backup_database(state: State<'_, AppState>, destination: String) -> Result<(), String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .backup(&destination).map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_database(state: State<'_, AppState>, source: String) -> Result<(), String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .restore(&source).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_invoice_json(state: State<'_, AppState>, invoice_id: String) -> Result<Value, String> {
    state.0.lock().map_err(|_| "Database lock poisoned".to_string())?
        .invoice_json(&invoice_id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("clear-fee.sqlite3");
            std::fs::create_dir_all(path.parent().expect("database parent"))?;
            let db = Database::open(&path).map_err(std::io::Error::other)?;
            app.manage(AppState(Mutex::new(db)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            calculate_totals, next_invoice_number, save_invoice, issue_invoice,
            create_credit_note, void_invoice, reverse_payment,
            backup_database, restore_database, export_invoice_json
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clear-fee");
}
