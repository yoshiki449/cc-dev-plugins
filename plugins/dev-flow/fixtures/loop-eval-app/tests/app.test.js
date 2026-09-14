import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'

describe('loop-eval-app API', () => {
  let app

  beforeEach(() => {
    app = createApp()
  })

  it('GET /health は status ok を返す', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('GET /api/todos は初期状態で空配列を返す', async () => {
    const res = await request(app).get('/api/todos')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('POST /api/todos は TODO を作成して 201 を返す', async () => {
    const res = await request(app).post('/api/todos').send({ title: '牛乳を買う' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ id: 1, title: '牛乳を買う', completed: false })
  })

  it('POST /api/todos は title 欠如で 400 を返す', async () => {
    const res = await request(app).post('/api/todos').send({})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'title is required' })
  })

  it('PATCH /api/todos/:id は completed を更新する', async () => {
    await request(app).post('/api/todos').send({ title: '掃除' })
    const res = await request(app).patch('/api/todos/1').send({ completed: true })
    expect(res.status).toBe(200)
    expect(res.body.completed).toBe(true)
  })

  it('PATCH /api/todos/:id は存在しない id で 404 を返す', async () => {
    const res = await request(app).patch('/api/todos/999').send({ completed: true })
    expect(res.status).toBe(404)
  })
})
