import { test, expect } from '@playwright/test'

test('TODO 管理: 画面表示と TODO 追加が一気通貫でできる', async ({ page }) => {
  await test.step('トップページが表示される', async () => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'TODO 管理' })).toBeVisible()
  })

  await test.step('TODO を追加すると一覧に表示される', async () => {
    await page.getByPlaceholder('やることを入力').fill('E2E テストを書く')
    await page.getByRole('button', { name: '追加' }).click()
    await expect(page.locator('#todo-list li')).toHaveCount(1)
    await expect(page.locator('#todo-list li').first()).toHaveText('E2E テストを書く')
  })
})
