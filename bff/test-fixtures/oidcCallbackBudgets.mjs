// Side-effect-free shared deadlines; importing this must not load the OIDC client.
// 2026-11-16, ok-console-gates:node22-kubectl1.34.1, --cpus=0.5 plus
// seven busy workers. Each row records REPORT.md's original sizing / final
// validation worst (ms), and sizing-measurements.json's four-run worst (ms).
// Budgets: max(30s, ceil(3 * largest uncensored observation / 1000)s).
// Replay is an explicit 60s exception: 15197ms was killed at the old 15s cap,
// NOT a completed observation. Eight expanded-cap samples (ms):
// 6902, 6679, 5811, 4997, 5800, 5816, 2701, 3995.
export const scenarioBudgetsMs = {
  'positive': 34000, // 5601 / 11002; four-run 5712
  'wrong-iss': 30000, // 6392 / 6392; four-run 7492
  'wrong-aud': 30000, // 7000 / 7000; four-run 7000
  'multi-aud-no-azp': 30000, // 7013 / 8205; four-run 7013
  'multi-aud-foreign-azp': 30000, // 8688 / 8688; four-run 8688
  'nonce': 30000, // 4220 / 4892; four-run 4891
  'state': 30000, // 3797 / 9903; four-run 4904
  'pkce': 30000, // 4779 / 6394; four-run 8308
  'redirect': 30000, // 2520 / 8288; four-run 6408
  'expired': 30000, // 4281 / 5901; four-run 6104
  'future-iat': 30000, // 3015 / 9189; four-run 6214
  'future-nbf': 30000, // 5286 / 7608; four-run 5787
  'token-untrusted-tls': 30000, // 5101 / 8097; four-run 5515
  'token-wrong-name': 30000, // 6213 / 7288; four-run 9789
  'http-issuer': 30000, // 4296 / 7987; four-run 4517
  'replay': 60000, // 3408 / 6985; four-run 15197 (censored)
  'single-aud-foreign-azp': 30000, // 3687 / 7509; four-run 5705
  'missing-id-token': 31000, // 3821 / 10095; four-run 8391
  'nonstring-sub': 30000, // 6789 / 8785; four-run 7014
  'untrusted-tls': 30000, // 3398 / 6421; four-run 6988
}
// Setup's 120s is a conservative allowance for five RSA requests and five
// certificate-signing commands under contention, not a measured 3x bound.
export const setupBudgetMs = 120000
// Largest prior loaded test stage: 205600ms (fixture plus assertions;
// full Vitest duration including worker startup/collection: 223200ms).
// 225000ms allows 19400ms (9.4%) above that total. Measured from Node start,
// including imports and setup; stop launching after the first scenario timeout.
// Worst case: 225s work + 10s kill/close, output and rmSync reserve; hook 239s
// (<4 minutes). Exec SIGTERM is handled to kill the group and remove the keys.
export const fixtureBudgetMs = 225000
export const execBudgetMs = 235000
export const hookBudgetMs = 239000
