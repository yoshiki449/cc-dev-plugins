/**
 * Playwright reporter 設定の正準形（cc-plugins / dev-flow 配下で共有）
 *
 * このファイルはプロジェクトから直接 import するものではない。
 * `enable-pw-reporter` スキルが各プロジェクトの playwright.config.ts を
 * 機械的に書き換えるときに参照する「正解のスニペット」として保持する。
 *
 * 採用理由:
 *   - `list`  : 開発中ターミナルで結果が読めるよう
 *   - `html`  : 失敗解析・スクリーンショット・トレース閲覧用
 *   - `json`  : dev-videos スキルが test-results/results.json を直接読んで
 *               video → 完全な日本語タイトルへのマッピングを取るため
 *
 * 各プロジェクトの playwright.config.ts ではこのスニペットの形を反映するだけで OK。
 */

export const reporter = [
  ['list'],
  ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ['json', { outputFile: 'test-results/results.json' }],
] as const;

/**
 * use ブロックの正準形。
 *
 *   - `viewport` : ユーザーの実環境（フルHD）に合わせて 1920x1080 固定。
 *                  未指定だと Playwright デフォルトの 1280x720 という
 *                  中途半端なサイズでブラウザが開く
 *   - `video` / `screenshot` / `trace` : 全テストで常時記録
 */
export const use = {
  viewport: { width: 1920, height: 1080 },
  video: 'on',
  screenshot: 'on',
  trace: 'on',
} as const;
