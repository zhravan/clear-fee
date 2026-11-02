use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::{Path, PathBuf}, fs};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")] Sql(#[from] rusqlite::Error),
    #[error("I/O error: {0}")] Io(#[from] std::io::Error),
    #[error("invalid input: {0}")] Invalid(String),
    #[error("serialization error: {0}")] Json(#[from] serde_json::Error),
}
type Result<T> = std::result::Result<T, DbError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineItem { pub description: String, pub quantity_milli: i64, pub unit_price_minor: i64 }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceDraft {
    pub id: Option<String>, pub business_id: String, pub client_id: String, pub number: String,
    pub issue_date: String, pub due_date: String, pub currency: String,
    pub items: Vec<LineItem>, pub discount_basis_points: i64, pub tax_basis_points: i64,
    pub client_snapshot: Value, pub business_snapshot: Value
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InvoiceTotals { pub subtotal_minor: i64, pub discount_minor: i64, pub taxable_minor: i64, pub tax_minor: i64, pub total_minor: i64 }

pub fn calculate_totals(items: &[LineItem], discount_bp: i64, tax_bp: i64) -> Result<InvoiceTotals> {
    if !(0..=10_000).contains(&discount_bp) || !(0..=100_000).contains(&tax_bp) {
        return Err(DbError::Invalid("discount or tax rate is outside allowed range".into()));
    }
    let mut subtotal: i64 = 0;
    for item in items {
        if item.quantity_milli <= 0 || item.unit_price_minor < 0 {
            return Err(DbError::Invalid("quantity must be positive and unit price cannot be negative".into()));
        }
        let line = item.quantity_milli.checked_mul(item.unit_price_minor)
            .ok_or_else(|| DbError::Invalid("line total overflow".into()))?;
        // Quantity is thousandths; round half up to the smallest currency unit.
        let rounded = line.checked_add(500).ok_or_else(|| DbError::Invalid("rounding overflow".into()))? / 1000;
        subtotal = subtotal.checked_add(rounded).ok_or_else(|| DbError::Invalid("subtotal overflow".into()))?;
    }
    let discount = round_ratio(subtotal, discount_bp, 10_000)?;
    let taxable = subtotal - discount;
    let tax = round_ratio(taxable, tax_bp, 10_000)?;
    let total = taxable.checked_add(tax).ok_or_else(|| DbError::Invalid("total overflow".into()))?;
    Ok(InvoiceTotals { subtotal_minor: subtotal, discount_minor: discount, taxable_minor: taxable, tax_minor: tax, total_minor: total })
}
fn round_ratio(value: i64, numerator: i64, denominator: i64) -> Result<i64> {
    let product=value.checked_mul(numerator).ok_or_else(||DbError::Invalid("amount overflow".into()))?;
    Ok((product + denominator/2) / denominator)
}

pub struct Database { conn: Connection, path: PathBuf }
impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent)=path.parent(){fs::create_dir_all(parent)?;}
        let conn=Connection::open(path)?;
        conn.pragma_update(None,"foreign_keys","ON")?;
        conn.pragma_update(None,"journal_mode","WAL")?;
        conn.pragma_update(None,"synchronous","FULL")?;
        let db=Self{conn,path:path.to_path_buf()}; db.migrate()?; Ok(db)
    }
    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);")?;
        let current:i64=self.conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
        if current < 1 {
            let tx=self.conn.unchecked_transaction()?;
            tx.execute_batch(include_str!("../migrations/0001_initial.sql"))?;
            tx.execute("INSERT INTO schema_migrations(version) VALUES(1)",[])?;
            tx.commit()?;
        }
        Ok(())
    }
    pub fn next_invoice_number(&mut self,business:&str,date:&str,prefix:&str)->Result<String>{
        let date=NaiveDate::parse_from_str(date,"%Y-%m-%d").map_err(|_|DbError::Invalid("date must use YYYY-MM-DD".into()))?;
        if prefix.trim().is_empty() || prefix.len()>20 {return Err(DbError::Invalid("invalid invoice prefix".into()));}
        // Indian financial year: 1 April to 31 March.
        let start=if date.month()>=4 {date.year()} else {date.year()-1};
        let fy=format!("{:02}{:02}",start.rem_euclid(100),(start+1).rem_euclid(100));
        let tx=self.conn.unchecked_transaction()?;
        tx.execute("INSERT INTO invoice_sequences(business_id,fiscal_year,prefix,next_value) VALUES(?1,?2,?3,1) ON CONFLICT(business_id,fiscal_year,prefix) DO UPDATE SET next_value=next_value+1",params![business,fy,prefix])?;
        let n:i64=tx.query_row("SELECT next_value FROM invoice_sequences WHERE business_id=?1 AND fiscal_year=?2 AND prefix=?3",params![business,fy,prefix],|r|r.get(0))?;
        tx.commit()?;
        Ok(format!("{}-{}/{}",prefix,fy,format_args!("{:04}",n)))
    }
    pub fn save_invoice(&mut self,d:InvoiceDraft)->Result<String>{
        validate_draft(&d)?;
        let id=d.id.unwrap_or_else(||Uuid::new_v4().to_string());
        let totals=calculate_totals(&d.items,d.discount_basis_points,d.tax_basis_points)?;
        let items=serde_json::to_string(&d.items)?;
        let client=serde_json::to_string(&d.client_snapshot)?;let business=serde_json::to_string(&d.business_snapshot)?;
        self.conn.execute("INSERT INTO invoices(id,business_id,client_id,number,status,issue_date,due_date,currency,items_json,client_snapshot_json,business_snapshot_json,subtotal_minor,discount_minor,tax_minor,total_minor,created_at,updated_at) VALUES(?1,?2,?3,?4,'draft',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,number=excluded.number,issue_date=excluded.issue_date,due_date=excluded.due_date,currency=excluded.currency,items_json=excluded.items_json,client_snapshot_json=excluded.client_snapshot_json,business_snapshot_json=excluded.business_snapshot_json,subtotal_minor=excluded.subtotal_minor,discount_minor=excluded.discount_minor,tax_minor=excluded.tax_minor,total_minor=excluded.total_minor,updated_at=CURRENT_TIMESTAMP WHERE invoices.status='draft'",
            params![id,d.business_id,d.client_id,d.number,d.issue_date,d.due_date,d.currency,items,client,business,totals.subtotal_minor,totals.discount_minor,totals.tax_minor,totals.total_minor])?;
        Ok(id)
    }
    pub fn issue_invoice(&mut self,id:&str)->Result<()> {
        let changed=self.conn.execute("UPDATE invoices SET status='issued',issued_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='draft'",[id])?;
        if changed!=1{return Err(DbError::Invalid("only a draft invoice can be issued".into()));} Ok(())
    }
    pub fn create_credit_note(&mut self,invoice:&str,number:&str,amount:i64,reason:&str)->Result<String>{
        if amount<=0||reason.trim().is_empty()||number.trim().is_empty(){return Err(DbError::Invalid("credit note requires a positive amount, number and reason".into()));}
        let id=Uuid::new_v4().to_string();
        self.conn.execute("INSERT INTO credit_notes(id,invoice_id,number,amount_minor,reason,status,created_at) SELECT ?1,id,?2,?3,?4,'issued',CURRENT_TIMESTAMP FROM invoices WHERE id=?5 AND status='issued'",params![id,number,amount,reason,invoice])?;
        let count:i64=self.conn.query_row("SELECT changes()",[],|r|r.get(0))?;
        if count!=1{return Err(DbError::Invalid("credit notes can only reference issued invoices".into()));}
        Ok(id)
    }
    pub fn void_invoice(&mut self,id:&str,reason:&str)->Result<()>{
        if reason.trim().is_empty(){return Err(DbError::Invalid("void reason is required".into()));}
        let tx=self.conn.unchecked_transaction()?;
        let paid:i64=tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE invoice_id=?1 AND reversed_at IS NULL",[id],|r|r.get(0))?;
        if paid>0{return Err(DbError::Invalid("reverse payments before voiding an invoice".into()));}
        let changed=tx.execute("UPDATE invoices SET status='void',void_reason=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status IN ('draft','issued')",params![id,reason])?;
        if changed!=1{return Err(DbError::Invalid("invoice cannot be voided in its current state".into()));}
        tx.commit()?;Ok(())
    }
    pub fn reverse_payment(&mut self,payment:&str,reason:&str)->Result<()>{
        if reason.trim().is_empty(){return Err(DbError::Invalid("payment reversal reason is required".into()));}
        let changed=self.conn.execute("UPDATE payments SET reversed_at=CURRENT_TIMESTAMP,reversal_reason=?2 WHERE id=?1 AND reversed_at IS NULL",params![payment,reason])?;
        if changed!=1{return Err(DbError::Invalid("payment is missing or already reversed".into()));}Ok(())
    }
    pub fn backup(&self,destination:&str)->Result<()>{
        let mut target=Connection::open(destination)?;
        let backup=rusqlite::backup::Backup::new(&self.conn,&mut target)?;
        backup.run_to_completion(128,std::time::Duration::from_millis(20),None)?;
        target.execute_batch("PRAGMA integrity_check;")?;
        Ok(())
    }
    pub fn restore(&mut self,source:&str)->Result<()>{
        let candidate=Connection::open(source)?;
        let check:String=candidate.query_row("PRAGMA integrity_check",[],|r|r.get(0))?;
        if check!="ok"{return Err(DbError::Invalid("backup failed SQLite integrity_check".into()));}
        let version:i64=candidate.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))
            .optional()?.unwrap_or(0);
        if version!=1{return Err(DbError::Invalid("backup schema version is not supported".into()));}
        let backup=rusqlite::backup::Backup::new(&candidate,&mut self.conn)?;
        backup.run_to_completion(128,std::time::Duration::from_millis(20),None)?;
        Ok(())
    }
    pub fn invoice_json(&self,id:&str)->Result<Value>{
        let raw:String=self.conn.query_row("SELECT json_object('id',id,'number',number,'status',status,'issueDate',issue_date,'dueDate',due_date,'currency',currency,'items',json(items_json),'client',json(client_snapshot_json),'business',json(business_snapshot_json),'subtotalMinor',subtotal_minor,'discountMinor',discount_minor,'taxMinor',tax_minor,'totalMinor',total_minor) FROM invoices WHERE id=?1",[id],|r|r.get(0))?;
        Ok(serde_json::from_str(&raw)?)
    }
}
fn validate_draft(d:&InvoiceDraft)->Result<()>{
    if d.business_id.is_empty()||d.client_id.is_empty()||d.number.trim().is_empty(){return Err(DbError::Invalid("business, client and invoice number are required".into()));}
    let issue=NaiveDate::parse_from_str(&d.issue_date,"%Y-%m-%d").map_err(|_|DbError::Invalid("invalid issue date".into()))?;
    let due=NaiveDate::parse_from_str(&d.due_date,"%Y-%m-%d").map_err(|_|DbError::Invalid("invalid due date".into()))?;
    if due<issue{return Err(DbError::Invalid("due date cannot precede issue date".into()));}
    if d.currency.len()!=3{return Err(DbError::Invalid("currency must be a three-letter code".into()));}
    if d.items.is_empty(){return Err(DbError::Invalid("invoice must contain at least one line item".into()));}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rounds_tax_and_discount_to_minor_units(){
        let items=vec![LineItem{description:"Service".into(),quantity_milli:1000,unit_price_minor:10001}];
        let t=calculate_totals(&items,500,1800).unwrap();
        assert_eq!(t.subtotal_minor,10001);assert_eq!(t.discount_minor,500);
        assert_eq!(t.taxable_minor,9501);assert_eq!(t.tax_minor,1710);assert_eq!(t.total_minor,11211);
    }
    #[test] fn rejects_negative_or_zero_quantities(){
        let items=vec![LineItem{description:"Bad".into(),quantity_milli:0,unit_price_minor:100}];
        assert!(calculate_totals(&items,0,0).is_err());
    }
    #[test] fn fiscal_year_changes_on_first_april(){
        let dir=tempfile::tempdir().unwrap();let mut db=Database::open(&dir.path().join("test.sqlite")).unwrap();
        assert_eq!(db.next_invoice_number("b","2026-03-31","INV").unwrap(),"INV-2526/0001");
        assert_eq!(db.next_invoice_number("b","2026-04-01","INV").unwrap(),"INV-2627/0001");
    }
}
