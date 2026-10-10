#!/usr/bin/env python3
"""Restore an Atoll data ZIP into a new portable SQLite database and files tree.

Uses only the Python standard library. Never writes into an existing directory.
This restores data; a target hosting/authentication adapter is still required.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import zipfile

TABLES = ["customers", "suppliers", "imports", "products", "orders", "order_items", "vin_requests",
          "topups", "ledger", "stock_movements", "purchase_runs", "purchase_orders",
          "purchase_order_items", "purchase_receipts", "purchase_receipt_items", "settings"]
DEFAULTS = {
    "customers": {"markup_bps": 0},
    "products": {"warehouse": "", "bin": "", "min_stock": 0},
    "orders": {"channel": "online", "fiscal_status": "not_sent"},
}
ID = re.compile(r"[A-Za-z0-9:_-]{1,80}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_archive(path):
    require(path.is_file() and path.stat().st_size <= 64_000_000, "Archive missing or larger than 64 MB.")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        require(len(infos) <= 1002, "Archive contains too many files.")
        require(len({i.filename for i in infos}) == len(infos), "Duplicate archive paths.")
        require(sum(i.file_size for i in infos) <= 80_000_000, "Expanded archive exceeds 80 MB.")
        require(all(i.file_size <= 16_000_000 for i in infos), "An archive entry exceeds 16 MB.")
        require("backup.json" in archive.namelist(), "Missing backup.json.")
        raw = archive.read("backup.json")
        data = json.loads(raw)
        require(data.get("format") == "inventory-atoll" and type(data.get("version")) is int and data["version"] in (1, 2, 3), "Unsupported backup format.")
        for table in TABLES:
            if table.startswith("purchase_") or table == "suppliers" and data["version"] < 3:
                data.setdefault(table, [])
            require(isinstance(data.get(table), list) and all(isinstance(row, dict) for row in data[table]), "Invalid table: " + table)
            if table != "settings":
                require(all(isinstance(row.get("id"), str) and ID.fullmatch(row["id"]) for row in data[table]), "Invalid row identifier: " + table)
        parts = {"backup.json": raw}
        for record in data["imports"]:
            if record.get("file_key"):
                name = "files/" + record["id"]
                require(name in archive.namelist(), "Missing price file: " + name)
                require(archive.getinfo(name).file_size <= 8_000_000, "A price file exceeds 8 MB.")
                parts[name] = archive.read(name)
        manifest = None
        if "manifest.json" in archive.namelist():
            manifest = json.loads(archive.read("manifest.json"))
            require(manifest.get("format") == "inventory-atoll-archive" and manifest.get("version") == 1 and isinstance(manifest.get("entries"), list), "Invalid checksum manifest.")
            entries = manifest["entries"]
            require(all(isinstance(entry, dict) and isinstance(entry.get("path"), str) for entry in entries), "Invalid manifest entries.")
            require(len({entry["path"] for entry in entries}) == len(entries), "Duplicate manifest paths.")
            require({entry["path"] for entry in entries} == set(parts), "The manifest does not match the database files.")
            for entry in entries:
                value = parts[entry["path"]]
                require(entry.get("size") == len(value) and entry.get("sha256") == hashlib.sha256(value).hexdigest(), "Checksum mismatch: " + entry["path"])
        require(data["version"] < 2 or manifest is not None, "Version 2/3 requires manifest.json.")
        require(data["version"] < 3 or all(record.get("supplier_id") for record in data["imports"] if record.get("source_type") == "supplier"), "A supplier price is missing its supplier ID.")
        return data, parts, manifest is not None


def check_database(connection):
    require(not connection.execute("PRAGMA foreign_key_check").fetchall(), "Broken foreign keys.")
    require(connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "SQLite integrity check failed.")
    require(not connection.execute("SELECT o.id FROM orders o LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id HAVING COUNT(i.id)=0 OR SUM(i.quantity*i.unit_price_cents)<>o.total_cents").fetchall(), "Order totals do not match their lines.")
    require(not connection.execute("SELECT o.id FROM purchase_orders o LEFT JOIN purchase_order_items i ON i.purchase_id=o.id GROUP BY o.id HAVING COUNT(i.id)=0 OR SUM(i.quantity*i.unit_cost_cents)<>o.total_cents").fetchall(), "Purchase totals do not match their lines.")
    require(not connection.execute("SELECT i.id FROM purchase_order_items i LEFT JOIN purchase_receipt_items r ON r.purchase_item_id=i.id GROUP BY i.id HAVING COALESCE(SUM(r.quantity),0)<>i.received_qty").fetchall(), "Purchase receipts do not match received quantities.")
    require(not connection.execute("SELECT r.id FROM purchase_receipt_items r JOIN purchase_receipts h ON h.id=r.receipt_id JOIN purchase_order_items i ON i.id=r.purchase_item_id WHERE h.purchase_id<>i.purchase_id").fetchall(), "Receipt lines refer to another purchase.")
    require(not connection.execute("SELECT o.id FROM purchase_orders o JOIN purchase_order_items i ON i.purchase_id=o.id WHERE (o.status='received' AND i.received_qty<>i.quantity) OR (o.status IN ('draft','cancelled') AND i.received_qty>0)").fetchall(), "Purchase status is inconsistent.")
    active = connection.execute("SELECT value FROM settings WHERE key LIKE 'active_import:%'").fetchall()
    require(all(connection.execute("SELECT 1 FROM imports WHERE id=?", value).fetchone() for value in active), "Active price references a missing import.")


def restore(archive_path, destination, migrations):
    require(not destination.exists(), "Destination already exists. Choose a new empty path.")
    data, parts, verified = load_archive(archive_path)
    require(migrations.is_dir(), "SQL migration directory is missing.")
    migration_files = sorted(migrations.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    require(migration_files, "No SQL migrations found.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="atoll-restore-", dir=destination.parent))
    connection = None
    try:
        files_dir = temporary / "files"
        files_dir.mkdir()
        connection = sqlite3.connect(temporary / "inventory.db")
        connection.execute("PRAGMA foreign_keys=ON")
        for migration in migration_files:
            connection.executescript(migration.read_text(encoding="utf-8"))
        connection.execute("BEGIN IMMEDIATE")
        for table in TABLES:
            columns = {row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')}
            for original in data[table]:
                row = {**DEFAULTS.get(table, {}), **original}
                # Auth identities are platform-specific and must be relinked on the target.
                row.pop("auth_user_id", None)
                if table == "imports" and row.get("file_key"):
                    filename = hashlib.sha256(row["id"].encode()).hexdigest()
                    (files_dir / filename).write_bytes(parts["files/" + row["id"]])
                    row["file_key"] = "files/" + filename
                fields = [key for key in row if key in columns]
                require(fields, "An empty row was found in " + table)
                query = 'INSERT INTO "' + table + '" (' + ",".join('"' + key + '"' for key in fields) + ') VALUES (' + ",".join("?" for _ in fields) + ")"
                values = [row[key] for key in fields]
                require(all(value is None or type(value) in (str, int) for value in values), "Invalid value in " + table)
                connection.execute(query, values)
        check_database(connection)
        connection.commit()
        counts = {table: connection.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0] for table in TABLES}
        connection.close()
        connection = None
        report = {"format": "inventory-atoll-sqlite-restore", "sourceVersion": data["version"], "checksumsVerified": verified, "counts": counts, "files": len(parts) - 1, "authenticationRequiresConfiguration": True}
        (temporary / "restore-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        # Exclusive destination claim avoids overwriting a concurrent restoration.
        destination.mkdir()
        try:
            for entry in temporary.iterdir():
                os.replace(entry, destination / entry.name)
        except Exception:
            shutil.rmtree(destination)
            raise
        shutil.rmtree(temporary)
        return report
    except Exception:
        if connection is not None:
            connection.close()
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--migrations", type=Path, default=Path(__file__).resolve().parent.parent / "drizzle")
    args = parser.parse_args()
    try:
        print(json.dumps(restore(args.archive.resolve(), args.destination.resolve(), args.migrations.resolve()), ensure_ascii=False))
    except (ValueError, OSError, sqlite3.Error, zipfile.BadZipFile, KeyError, TypeError) as error:
        parser.exit(1, "Restore stopped: " + str(error) + "\n")


if __name__ == "__main__":
    main()
