import { fireEvent, render, screen } from '@testing-library/react'
import documentJson from './test-fixtures/example/branding.json'
import { describe, expect, it, vi } from 'vitest'
import { resolveBranding, validateBranding } from '../../bff/branding.mjs'
import AuthEntry from '../auth/AuthEntry'
import App from '../App'
import { BrandingProvider } from './BrandingContext'
import BrandingFailure from './BrandingFailure'
import { DeploymentPolicyProvider } from '../deploymentPolicy'

const brandingDocument: Record<string, unknown> = structuredClone(documentJson)

const validated = validateBranding(brandingDocument)
if (!validated.ok) throw new Error(validated.errors.join('\n'))
const example = resolveBranding(validated.value)

describe('white-label branding in the Console', () => {
  it('brands the login shell from configuration, including the optional powered-by line', () => {
    const { container } = render(<BrandingProvider branding={example}><AuthEntry authMode="prototype" onAuthenticated={vi.fn()}/></BrandingProvider>)
    expect(screen.getByAltText('Example Ops')).toHaveAttribute('src', './branding/example-mark.svg')
    expect(screen.getByRole('heading', { name: /Observe.*Explain.*Prove/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome to Example Ops' })).toBeInTheDocument()
    expect(screen.getByText('Synthetic brand · tests only')).toBeInTheDocument()
    expect(container.querySelector('.auth-panel-footer')).toHaveTextContent('PrivacySecurityExample Ops')
    expect(container.querySelector('.auth-powered-by')).toHaveTextContent('Powered by Example Platform')
    expect(container.textContent).not.toMatch(/OpenKubes Console|Welcome to OpenKubes/)
  })

  it('keeps the built-in identity and shows no powered-by line without configuration', () => {
    const { container } = render(<AuthEntry authMode="prototype" onAuthenticated={vi.fn()}/>)
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome to OpenKubes' })).toBeInTheDocument()
    expect(container.querySelector('.powered-by')).toBeNull()
  })

  it('brands the application shell after sign-in', async () => {
    window.location.hash = '#/overview'
    const { container } = render(<BrandingProvider branding={example}><App/></BrandingProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /Continue with OpenKubes Identity/i }))
    fireEvent.click(screen.getByRole('button', { name: /Simulate identity provider return/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Enter Console/i }))
    await screen.findByRole('button', { name: 'Sign out of Example Ops Console' })
    expect(container.querySelector('.brand img')).toHaveAttribute('src', './branding/example-mark.svg')
    expect(container.querySelector('.brand')).toHaveTextContent('Example OpsSynthetic test brand')
    expect(container.querySelector('.breadcrumbs')).toHaveTextContent('Example Ops')
    expect(container.querySelector('.sidebar-powered-by')).toHaveTextContent('Powered by Example Platform')
    expect(document.title).toMatch(/· Example Ops Console$/)
  })

  it('neutralizes generic OpenKubes wording but keeps technical origin in a white-label installation', async () => {
    window.location.hash = '#/overview'
    const { container } = render(<BrandingProvider branding={example}><App/></BrandingProvider>)
    expect(screen.getByText(/Example Ops evaluates authority separately/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Continue with OpenKubes Identity/i }))
    expect(screen.getByText(/Example Ops never receives your provider password/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Simulate identity provider return/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Enter Console/i }))
    await screen.findByRole('button', { name: 'Sign out of Example Ops Console' })
    expect(screen.getByText('One evidence-backed view across your sovereign Kubernetes platforms.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ask AI/ })).toBeInTheDocument()
    expect(screen.queryByText(/OK AI/)).toBeNull()
    expect(container.querySelector('.context-switcher')).toHaveTextContent('DistributionOpenKubes Platform')
    expect(container.querySelector('.product-footer')).toHaveTextContent('Example Ops Console Prototype · Built on OpenKubes Console')
  })

  const enterConsole = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Continue with OpenKubes Identity/i }))
    fireEvent.click(screen.getByRole('button', { name: /Simulate identity provider return/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Enter Console/i }))
    await screen.findByRole('button', { name: /^Sign out of/ })
  }
  const readOnly = { policy: 'fixture-read-only' as const, clusterLifecycleAvailable: false }

  it('locks cluster create and register under the fixture-read-only policy, without any branding', async () => {
    window.location.hash = '#/create'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { container } = render(<DeploymentPolicyProvider policy={readOnly}><App/></DeploymentPolicyProvider>)
    await enterConsole()
    expect(screen.getByRole('button', { name: 'Sign out of OpenKubes Console' })).toBeInTheDocument()
    expect(await screen.findByRole('note', { name: 'Cluster lifecycle not available' })).toHaveTextContent('fixture-read-only deployment policy')
    expect(container.querySelector('a[href="#/create"], a[href="#/register"]')).toBeNull()
    expect(container.querySelectorAll('.cluster-quick-actions [aria-disabled="true"]')).toHaveLength(2)
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('create-cluster'))).toBe(false)
    fetchSpy.mockRestore()
  })

  it('never lets branding decide: a white-label brand without a policy keeps cluster lifecycle', async () => {
    window.location.hash = '#/overview'
    const { container } = render(<BrandingProvider branding={example}><App/></BrandingProvider>)
    await enterConsole()
    expect(screen.getByRole('button', { name: 'Sign out of Example Ops Console' })).toBeInTheDocument()
    expect(container.querySelector('a[href="#/create"]')).not.toBeNull()
    expect(container.querySelector('a[href="#/register"]')).not.toBeNull()
  })

  it('combines a brand with the policy for MVP-0 installations', async () => {
    window.location.hash = '#/clusters'
    const { container } = render(<DeploymentPolicyProvider policy={readOnly}><BrandingProvider branding={example}><App/></BrandingProvider></DeploymentPolicyProvider>)
    await enterConsole()
    expect(screen.getByRole('note')).toHaveTextContent('Read-only installation · cluster lifecycle unavailable')
    expect(container.querySelector('.brand')).toHaveTextContent('Example Ops')
  })

  it('keeps cluster create and register available without configuration', async () => {
    window.location.hash = '#/overview'
    const { container } = render(<App/>)
    await enterConsole()
    expect(screen.getByRole('button', { name: 'Sign out of OpenKubes Console' })).toBeInTheDocument()
    expect(container.querySelector('a[href="#/create"]')).not.toBeNull()
    expect(container.querySelector('a[href="#/register"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Ask OK AI/ })).toBeInTheDocument()
  })

  it('shows a neutral failure screen without any product identity', () => {
    const onRetry = vi.fn()
    const { container } = render(<BrandingFailure errors={['colors.primary: too light']} onRetry={onRetry}/>)
    expect(screen.getByRole('alert')).toHaveTextContent('Console unavailable')
    expect(container.textContent).not.toMatch(/OpenKubes|Example Ops/)
    expect(container.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })
})
