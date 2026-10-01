from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sqlite3
import requests
import uuid

app = FastAPI(title="Складской учет + АТОЛ 50Ф")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def init_db():
    conn = sqlite3.connect('inventory.db')
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE,
            name TEXT,
            category TEXT,
            stock INTEGER,
            price REAL
        )
    ''')
    conn.commit()
    conn.close()

init_db()

class Product(BaseModel):
    code: str
    name: str
    category: str
    stock: int
    price: float

class SaleItem(BaseModel):
    code: str
    quantity: int

class SaleRequest(BaseModel):
    items: list[SaleItem]
    payment_type: str = "cash"

@app.get("/api/products")
def get_products():
    conn = sqlite3.connect('inventory.db')
    cursor = conn.cursor()
    cursor.execute("SELECT id, code, name, category, stock, price FROM products")
    rows = cursor.fetchall()
    conn.close()
    return [{"id": r[0], "code": r[1], "name": r[2], "category": r[3], "stock": r[4], "price": r[5]} for r in rows]

@app.post("/api/products")
def add_product(product: Product):
    conn = sqlite3.connect('inventory.db')
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO products (code, name, category, stock, price) VALUES (?, ?, ?, ?, ?)",
            (product.code, product.name, product.category, product.stock, product.price)
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Товар с таким артикулом уже существует")
    conn.close()
    return {"status": "success"}

@app.post("/api/sell")
def make_sale(sale: SaleRequest, atol_web_url: str = "http://localhost:16732"):
    conn = sqlite3.connect('inventory.db')
    cursor = conn.cursor()

    atol_items = []
    total_sum = 0.0

    for item in sale.items:
        cursor.execute("SELECT name, price, stock FROM products WHERE code = ?", (item.code,))
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
        cursor.execute("UPDATE products SET stock = stock - ? WHERE code = ?", (item.quantity, item.code))

    conn.commit()
    conn.close()

    return {"status": "success", "message": "Чек пробит"}
