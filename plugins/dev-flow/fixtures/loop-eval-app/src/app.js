import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use(express.static(path.join(__dirname, '..', 'public')))

  // インメモリの TODO ストア（テストごとに createApp() で初期化される）
  const todos = []
  let nextId = 1

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/api/todos', (_req, res) => {
    res.json(todos)
  })

  app.post('/api/todos', (req, res) => {
    const { title } = req.body ?? {}
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required' })
    }
    const todo = { id: nextId++, title, completed: false }
    todos.push(todo)
    res.status(201).json(todo)
  })

  app.patch('/api/todos/:id', (req, res) => {
    const todo = todos.find((t) => t.id === Number(req.params.id))
    if (!todo) {
      return res.status(404).json({ error: 'todo not found' })
    }
    if (typeof req.body?.completed === 'boolean') {
      todo.completed = req.body.completed
    }
    res.json(todo)
  })

  return app
}
