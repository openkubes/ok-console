// Shown instead of the Console when a configured brand cannot be loaded. Deliberately carries no product
// name or logo, so a broken white-label installation never silently turns into a different brand.
export default function BrandingFailure({ errors, onRetry }: { errors: string[]; onRetry: () => void }) {
  return <main className="branding-failure" role="alert" aria-labelledby="branding-failure-title">
    <h1 id="branding-failure-title">Console unavailable</h1>
    <p>This installation has a branding configuration that could not be loaded. The Console is not shown with a different brand.</p>
    <p>Please contact your administrator.</p>
    {errors.length > 0 && <details><summary>Technical details</summary><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></details>}
    <button type="button" onClick={onRetry}>Retry</button>
  </main>
}
