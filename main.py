from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import sqlite3
import psycopg
import requests
import uuid
import os
import hashlib
import secrets

app = FastAPI(title="Складской учет + АТОЛ 50Ф")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
DB_PATH = os.environ.get("INVENTORY_DB_PATH", "/var/data/inventory.db" if os.path.isdir("/var/data") else "inventory.db")

def get_conn():
    return psycopg.connect(DATABASE_URL) if DATABASE_URL else sqlite3.connect(DB_PATH)

def execute(conn, query, params=()):
    return conn.execute(query.replace("?", "%s") if DATABASE_URL else query, params)
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120000)
    return salt.hex() + ":" + digest.hex()

def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split(":", 1)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 120000)
        return secrets.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False

def init_db():
    conn = get_conn()
    cursor = conn.cursor()
    ID_DEF = "SERIAL PRIMARY KEY" if DATABASE_URL else "INTEGER PRIMARY KEY AUTOINCREMENT"
    execute(cursor, '''
        CREATE TABLE IF NOT EXISTS users (
            id {ID_DEF},
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    execute(cursor, '''
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    execute(cursor, '''
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')
    execute(cursor, '''
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            code TEXT UNIQUE,
            name TEXT,
            category TEXT,
            stock INTEGER,
            price REAL
        )
    ''')
    # One-time migration for the initial administrator.
    initialized = execute(cursor, "SELECT value FROM app_settings WHERE key = 'default_admin_initialized'").fetchone()
    if not initialized:
        initial_password = "0" * 4
        admin = execute(cursor, "SELECT id FROM users WHERE username = 'admin' LIMIT 1").fetchone()
        if admin:
            execute(cursor, "UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(initial_password), admin[0]))
        else:
            first_user = execute(cursor, "SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
            if first_user:
                execute(cursor, "UPDATE users SET username = 'admin', password_hash = ? WHERE id = ?", (hash_password(initial_password), first_user[0]))
            else:
                execute(cursor, "INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id", ("admin", hash_password(initial_password)))
        execute(cursor, "INSERT INTO app_settings (key, value) VALUES ('default_admin_initialized', '1') ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value")
    conn.commit()
    conn.close()

init_db()

class AuthRequest(BaseModel):
    username: str
    password: str

class CredentialsChangeRequest(BaseModel):
    username: str
    password: str

class Product(BaseModel):
    code: str
    name: str
    category: str
    stock: int = Field(ge=0)
    price: float = Field(gt=0)

class SaleItem(BaseModel):
    code: str
    quantity: int = Field(gt=0)

class StockUpdate(BaseModel):
    stock: int = Field(ge=0)

class SaleRequest(BaseModel):
    items: list[SaleItem]
    payment_type: str = "cash"



def get_user(token: str):
    conn = get_conn()
    cursor = conn.cursor()
    execute(cursor, "SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?", (token,))
    row = cursor.fetchone()
    conn.close()
    return row

def require_user(token: str):
    user = get_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Требуется вход в личный кабинет")
    return user

@app.post("/api/auth/setup-admin")
def register(auth: AuthRequest):
    conn = get_conn()
    if execute(conn, "SELECT COUNT(*) FROM users").fetchone()[0] > 0:
        conn.close()
        raise HTTPException(status_code=403, detail="Администратор уже создан")
    username = auth.username.strip()
    if len(username) < 3 or len(username) > 50 or len(auth.password) < 4:
        raise HTTPException(status_code=400, detail="Логин: 3–50 символов, пароль: минимум 4 символа")
    cursor = conn.cursor()
    try:
        execute(cursor, "INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id", (username, hash_password(auth.password)))
        user_id = execute(cursor, "SELECT id FROM users WHERE username = ?", (username,)).fetchone()[0]
        token = secrets.token_urlsafe(32)
        execute(cursor, "INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Такой логин уже занят")
    conn.close()
    return {"status": "success", "token": token, "username": username}

@app.post("/api/auth/login")
def login(auth: AuthRequest):
    conn = get_conn()
    cursor = conn.cursor()
    execute(cursor, "SELECT id, username, password_hash FROM users WHERE username = ?", (auth.username.strip(),))
    row = cursor.fetchone()
    if not row or not verify_password(auth.password, row[2]):
        conn.close()
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    token = secrets.token_urlsafe(32)
    execute(cursor, "INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, row[0]))
    conn.commit()
    conn.close()
    return {"status": "success", "token": token, "username": row[1]}

@app.get("/api/auth/me")
def me(token: str = ""):
    user = require_user(token)
    return {"username": user[1]}

@app.put("/api/auth/credentials")
def change_credentials(data: CredentialsChangeRequest, authorization: str | None = Header(default=None)):
    token = authorization.replace("Bearer ", "", 1) if authorization else ""
    user = require_user(token)
    username = data.username.strip()
    if len(username) < 3 or len(username) > 50:
        raise HTTPException(status_code=400, detail="Логин должен содержать от 3 до 50 символов")
    if len(data.password) < 4:
        raise HTTPException(status_code=400, detail="Пароль должен содержать минимум 4 символа")
    conn = get_conn()
    try:
        execute(conn, "UPDATE users SET username = ?, password_hash = ? WHERE id = ?", (username, hash_password(data.password), user[0]))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Такой логин уже занят")
    conn.close()
    return {"status": "success", "username": username}

@app.post("/api/auth/logout")
def logout(token: str = ""):
    conn = get_conn()
    execute(conn, "DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()
    conn.close()
    return {"status": "success"}

@app.get("/")
def read_root():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"message": "index.html не найден"}

@app.get("/api/public/products")
def get_public_products():
    conn = get_conn()
    rows = execute(conn, "SELECT id, code, name, category, stock, price FROM products").fetchall()
    conn.close()
    return [{"id": r[0], "code": r[1], "name": r[2], "category": r[3], "stock": r[4], "price": r[5]} for r in rows]

@app.get("/api/products")
def get_products(authorization: str | None = Header(default=None)):
    require_user(authorization.replace("Bearer ", "", 1) if authorization else "")
    conn = get_conn()
    cursor = conn.cursor()
    execute(cursor, "SELECT id, code, name, category, stock, price FROM products")
    rows = cursor.fetchall()
    conn.close()
    return [{"id": r[0], "code": r[1], "name": r[2], "category": r[3], "stock": r[4], "price": r[5]} for r in rows]

@app.post("/api/products")
def add_product(product: Product, authorization: str | None = Header(default=None)):
    require_user(authorization.replace("Bearer ", "", 1) if authorization else "")
    conn = get_conn()
    cursor = conn.cursor()
    try:
        execute(cursor,
            "INSERT INTO products (code, name, category, stock, price) VALUES (?, ?, ?, ?, ?)",
            (product.code, product.name, product.category, product.stock, product.price)
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Товар с таким артикулом уже существует")
    conn.close()
    return {"status": "success"}

@app.put("/api/products/{product_id}/stock")
def update_stock(product_id: int, update: StockUpdate, authorization: str | None = Header(default=None)):
    require_user(authorization.replace("Bearer ", "", 1) if authorization else "")
    conn = get_conn()
    cursor = conn.cursor()
    execute(cursor, "SELECT id FROM products WHERE id = ?", (product_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Товар не найден")
    execute(cursor, "UPDATE products SET stock = ? WHERE id = ?", (update.stock, product_id))
    conn.commit()
    conn.close()
    return {"status": "success", "stock": update.stock}

@app.post("/api/sell")
def make_sale(sale: SaleRequest, atol_web_url: str = "http://localhost:16732", authorization: str | None = Header(default=None)):
    require_user(authorization.replace("Bearer ", "", 1) if authorization else "")
    conn = get_conn()
    cursor = conn.cursor()

    atol_items = []
    total_sum = 0.0

    for item in sale.items:
        execute(cursor, "SELECT name, price, stock FROM products WHERE code = ?", (item.code,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail=f"Товар {item.code} не найден")
        
        name, price, stock = row
        if stock < item.quantity:
            conn.close()
            raise HTTPException(status_code=400, detail=f"Недостаточно товара '{name}' на складе")

        amount = price * item.quantity
        total_sum += amount

        atol_items.append({
            "type": "position",
            "name": name[:128],
            "price": price,
            "quantity": item.quantity,
            "amount": amount,
            "tax": {"type": "none"}
        })

    task_id = str(uuid.uuid4())
    atol_payload = {
        "uuid": task_id,
        "request": [
            {
                "type": "sell",
                "taxationType": "osn",
                "items": atol_items,
                "payments": [
                    {
                        "type": sale.payment_type,
                        "sum": total_sum
                    }
                ]
            }
        ]
    }

    try:
        response = requests.post(f"{atol_web_url}/api/v2/requests", json=atol_payload, timeout=5)
        if response.status_code not in (200, 201):
            conn.close()
            raise HTTPException(status_code=500, detail="Ошибка кассы АТОЛ")
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=503, detail="Касса недоступна")

    for item in sale.items:
        execute(cursor, "UPDATE products SET stock = stock - ? WHERE code = ?", (item.quantity, item.code))

    conn.commit()
    conn.close()

    return {"status": "success", "message": "Чек пробит"}
