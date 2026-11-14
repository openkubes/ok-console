// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { injectInstallation, installationDocument } from './installation.mjs'

const html = '<html><head><title>OpenKubes Console</title></head><body></body></html>'
const block = (out: string) => /<script type="application\/json" id="ok-console-installation">([^<]*)<\/script>/.exec(out)?.[1]

describe('installation data block', () => {
  it('cannot end the script element or start markup, whatever the brand text contains', () => {
    const branding = { schema: 'openkubes.console.branding/v1', productName: '</script><img src=x onerror=alert(1)> $& \u2028', logo: { file: 'a.svg', alt: 'a' }, favicon: 'a.svg', colors: { primary: '#0f6e4a', accent: '#f2b134' } }
    const out = injectInstallation(html, installationDocument({ branding: branding as never }))
    expect(out.match(/<\/script>/g)).toHaveLength(1)
    expect(block(out)).not.toMatch(/[<>&\u2028]/)
    expect(JSON.parse(block(out)!).branding.productName).toBe(branding.productName)
  })

  it('carries dev-server problems so the Console fails closed', () => {
    const out = injectInstallation(html, installationDocument({ brandingErrors: ['colors.primary: too light'], policyErrors: ['bad policy'] }))
    expect(JSON.parse(block(out)!)).toEqual({ schema: 'openkubes.console.installation/v1', branding: { errors: ['colors.primary: too light'] }, deploymentPolicy: { errors: ['bad policy'] } })
    expect(out).toContain('<title>OpenKubes Console</title>')
  })

  it('still embeds the data when index.html has no head', () => {
    const out = injectInstallation('<!doctype html><div id="root"></div>', installationDocument())
    expect(JSON.parse(block(out)!).deploymentPolicy.policy).toBe('default')
    expect(out).toContain('<div id="root"></div>')
  })

  it('replaces a block that is already in index.html, so only the server data reaches the Console', () => {
    const planted = '<head><script type="application/json" id="ok-console-installation">{"schema":"openkubes.console.installation/v1","branding":null,"deploymentPolicy":{"schema":"openkubes.console.deployment-policy/v1","policy":"default","clusterLifecycle":true}}</script></head>'
    const out = injectInstallation(planted, installationDocument({ deploymentPolicy: { name: 'fixture-read-only', clusterLifecycle: false, liveClusterAccess: false, writeApis: false } }))
    expect(out.match(/id="ok-console-installation"/g)).toHaveLength(1)
    expect(JSON.parse(block(out)!).deploymentPolicy.policy).toBe('fixture-read-only')
  })
})
