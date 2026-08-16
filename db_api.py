
import sqlite3
from flask import Flask, request, jsonify
from pathlib import Path
from typing import Optional

# Use a workspace-relative absolute path so code always opens the same DB,
# even if the current working directory changes at runtime.
DB_PATH = str(Path(__file__).resolve().parent / "ozpay.db")


def get_conn():
	# Helpful debug: show which DB file is being opened when running from different cwd
	print(f"[db_api] opening DB: {DB_PATH}")
	conn = sqlite3.connect(DB_PATH)
	conn.row_factory = sqlite3.Row
	# Ensure the accounts table exists so callers can assume schema is present
	cur = conn.cursor()
	cur.execute(
		"""
		CREATE TABLE IF NOT EXISTS accounts (
			device TEXT PRIMARY KEY,
			ip TEXT,
			port INTEGER,
			number TEXT,
			password TEXT,
			name TEXT,
			balance REAL,
			income REAL,
			outcome REAL,
			cards TEXT
		)
		"""
	)
	conn.commit()
	return conn


def init_db():
	conn = get_conn()
	cur = conn.cursor()
	cur.execute(
		"""
		CREATE TABLE IF NOT EXISTS accounts (
			device TEXT PRIMARY KEY,
			ip TEXT,
			port INTEGER,
			number TEXT,
			password TEXT,
			name TEXT,
			balance REAL,
			income REAL,
			outcome REAL,
			cards TEXT
		)
		"""
	)
	conn.commit()
	conn.close()


def create_device(device: str, **fields):
	"""Create a device row. Pass any of the columns as keyword args."""
	init_db()
	conn = get_conn()
	cur = conn.cursor()
	cur.execute(
		"INSERT INTO accounts (device, ip, port, number, password, name, balance, income, outcome, cards) VALUES (?,?,?,?,?,?,?,?,?,?)",
		(
			device,
			fields.get('ip'),
			fields.get('port'),
			fields.get('number'),
			fields.get('password'),
			fields.get('name'),
			fields.get('balance'),
			fields.get('income'),
			fields.get('outcome'),
			fields.get('cards'),
		),
	)
	conn.commit()
	conn.close()


def find_device_by_ip_port(ip: str, port) -> Optional[dict]:
	if not ip or port in (None, ""):
		return None
	try:
		port = int(port)
	except (TypeError, ValueError):
		return None
	conn = get_conn()
	cur = conn.cursor()
	cur.execute("SELECT * FROM accounts WHERE ip = ? AND port = ?", (ip, port))
	row = cur.fetchone()
	conn.close()
	if not row:
		return None
	return dict(row)


def delete_device(device: str) -> bool:
	conn = get_conn()
	cur = conn.cursor()
	cur.execute("DELETE FROM accounts WHERE device = ?", (device,))
	conn.commit()
	changed = cur.rowcount
	conn.close()
	return changed > 0


def get_device(device: str):
	conn = get_conn()
	cur = conn.cursor()
	cur.execute("SELECT * FROM accounts WHERE device = ?", (device,))
	row = cur.fetchone()
	conn.close()
	if not row:
		return None
	return dict(row)


def list_devices():
	conn = get_conn()
	cur = conn.cursor()
	cur.execute("SELECT * FROM accounts")
	rows = cur.fetchall()
	conn.close()
	return [dict(r) for r in rows]


def update_device(device: str, data: dict) -> bool:
	"""Generic update by device. `data` keys should be column names."""
	allowed = ['ip', 'port', 'number', 'password', 'name', 'balance', 'income', 'outcome', 'cards']
	set_parts = []
	params = []
	for k, v in data.items():
		if k in allowed:
			set_parts.append(f"{k} = ?")
			params.append(v)
	if not set_parts:
		return False
	params.append(device)
	conn = get_conn()
	cur = conn.cursor()
	cur.execute(f"UPDATE accounts SET {', '.join(set_parts)} WHERE device = ?", params)
	conn.commit()
	changed = cur.rowcount
	conn.close()
	return changed > 0


# --- Simple get/update helpers for each column ---


def _get_field(device: str, field: str):
	conn = get_conn()
	cur = conn.cursor()
	cur.execute(f"SELECT {field} FROM accounts WHERE device = ?", (device,))
	row = cur.fetchone()
	conn.close()
	if not row:
		return None
	return row[0]


def _update_field(device: str, field: str, value) -> bool:
	conn = get_conn()
	cur = conn.cursor()
	cur.execute(f"UPDATE accounts SET {field} = ? WHERE device = ?", (value, device))
	conn.commit()
	changed = cur.rowcount
	conn.close()
	return changed > 0


# ip
def get_ip(device: str):
	return _get_field(device, 'ip')


def update_ip(device: str, ip: str) -> bool:
	return _update_field(device, 'ip', ip)


# port
def get_port(device: str):
	return _get_field(device, 'port')


def update_port(device: str, port: int) -> bool:
	return _update_field(device, 'port', port)


# number (phone) - user requested phone helpers
def get_number(device: str):
	return _get_field(device, 'number')


def update_number(device: str, number: str) -> bool:
	return _update_field(device, 'number', number)


def get_phone(device: str):
	return get_number(device)


def update_phone(device: str, phone: str) -> bool:
	return update_number(device, phone)


# name
def get_name(device: str):
	return _get_field(device, 'name')


def update_name(device: str, name: str) -> bool:
	return _update_field(device, 'name', name)


# balance
def get_balance(device: str):
	return _get_field(device, 'balance')


def update_balance(device: str, balance: float) -> bool:
	return _update_field(device, 'balance', balance)


# income
def get_income(device: str):
	return _get_field(device, 'income')


def update_income(device: str, income: float) -> bool:
	return _update_field(device, 'income', income)


# outcome
def get_outcome(device: str):
	return _get_field(device, 'outcome')


def update_outcome(device: str, outcome: float) -> bool:
	return _update_field(device, 'outcome', outcome)


# cards
def get_cards(device: str):
	return _get_field(device, 'cards')


def update_cards(device: str, cards: str) -> bool:
	return _update_field(device, 'cards', cards)


# password
def get_password(device: str):
	return _get_field(device, 'password')


def update_password(device: str, password: str) -> bool:
	return _update_field(device, 'password', password)


