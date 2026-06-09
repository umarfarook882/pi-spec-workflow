---
id: api-01
name: "FastAPI Todo CRUD"
phase: 1
test_ids:
  - "test_create_todo"
  - "test_get_todos"
test_cmd: "pytest test_api.py"
creates:
  - "main.py"
tests:
  - "test_api.py"
---

Create a FastAPI backend for a Todo application.

Requirements:
1. Define a Pydantic `Todo` model with `id` (int), `title` (str), and `completed` (bool, default False).
2. Create an in-memory list to store todos.
3. Implement `POST /todos` to create a new todo. It should automatically assign an auto-incrementing ID.
4. Implement `GET /todos` to retrieve all todos.

The tests should verify these two endpoints.
