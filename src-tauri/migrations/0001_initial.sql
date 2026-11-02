CREATE TABLE businesses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'INR', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL, email TEXT, phone TEXT, address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE invoice_sequences (
  business_id TEXT NOT NULL REFERENCES businesses(id), fiscal_year TEXT NOT NULL,
  prefix TEXT NOT NULL, next_value INTEGER NOT NULL CHECK(next_value > 0),
  PRIMARY KEY(business_id,fiscal_year,prefix)
);
CREATE TABLE invoices (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
  client_id TEXT NOT NULL REFERENCES clients(id), number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('draft','issued','void')),
  issue_date TEXT NOT NULL, due_date TEXT NOT NULL, currency TEXT NOT NULL CHECK(length(currency)=3),
  items_json TEXT NOT NULL, client_snapshot_json TEXT NOT NULL, business_snapshot_json TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor>=0), discount_minor INTEGER NOT NULL CHECK(discount_minor>=0),
  tax_minor INTEGER NOT NULL CHECK(tax_minor>=0), total_minor INTEGER NOT NULL CHECK(total_minor>=0),
  void_reason TEXT, issued_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0), method TEXT NOT NULL,
  reference TEXT, received_at TEXT NOT NULL, reversed_at TEXT, reversal_reason TEXT
);
CREATE TABLE credit_notes (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  number TEXT NOT NULL UNIQUE, amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('issued','void')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invoices_client ON invoices(client_id,issue_date);
CREATE INDEX idx_invoices_status_due ON invoices(status,due_date);
CREATE INDEX idx_payments_invoice ON payments(invoice_id,received_at);
