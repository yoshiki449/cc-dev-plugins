import { createApp } from './app.js'

const PORT = process.env.PORT || 3987
const app = createApp()

app.listen(PORT, () => {
  console.log(`loop-eval-app listening on http://localhost:${PORT}`)
})
