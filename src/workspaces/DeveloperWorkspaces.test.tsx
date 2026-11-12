import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DeveloperWorkspaces from './DeveloperWorkspaces'

describe('Developer Workspace preview', () => {
  it('shows fixture details and a pending blocker without inventing a successful result', () => {
    render(<DeveloperWorkspaces/>)
    fireEvent.click(screen.getByRole('button', { name: /Inspect Pull request review/ }))
    expect(screen.getByRole('heading', { name: 'Review evidence exported' })).toBeInTheDocument()
    expect(screen.getByText('Read-only source access')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /All workspaces/ }))
    fireEvent.click(screen.getByRole('button', { name: /Inspect Contract test runner/ }))
    expect(screen.getByRole('heading', { name: 'Awaiting runtime readiness' })).toBeInTheDocument()
    expect(screen.queryByText(/Example receipt:/)).not.toBeInTheDocument()
  })

  it('reviews selected capabilities, retains edits and finishes locally without a request', () => {
    const request = vi.spyOn(globalThis, 'fetch')
    render(<DeveloperWorkspaces/>)
    fireEvent.click(screen.getByRole('button', { name: /Create Workspace/ }))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Contract review demo' } })
    fireEvent.change(screen.getByLabelText('Source revision'), { target: { value: 'review/contracts' } })
    fireEvent.click(screen.getByRole('radio', { name: /Review Inspect/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Documentation search/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Model access/ }))
    fireEvent.click(screen.getByRole('button', { name: /Review configuration/ }))
    const summary = JSON.parse(screen.getByLabelText('Workspace intent preview').textContent!)
    expect(summary).toMatchObject({ previewOnly: true, name: 'Contract review demo', source: { revision: 'review/contracts' }, lifecycleProfile: 'review', capabilities: { git: 'read-only', inference: 'none', kubernetes: 'none', tools: ['documentation search (read-only)'] } })
    fireEvent.click(screen.getByRole('button', { name: /Back to configuration/ }))
    expect(screen.getByLabelText('Workspace name')).toHaveValue('Contract review demo')
    fireEvent.click(screen.getByRole('button', { name: /Review configuration/ }))
    fireEvent.click(screen.getByRole('button', { name: /Finish preview/ }))
    expect(within(screen.getByRole('status')).getByText(/No workspace was provisioned/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Return to workspaces/ }))
    expect(screen.getByRole('heading', { name: 'Developer Workspaces' })).toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
    request.mockRestore()
  })

  it('blocks blank names and resets configuration for a repeatable demo', () => {
    render(<DeveloperWorkspaces/>)
    fireEvent.click(screen.getByRole('button', { name: /Create Workspace/ }))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: /Review configuration/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: /Create Workspace/ }))
    expect(screen.getByLabelText('Workspace name')).toHaveValue('W-JAX demo workspace')
  })
})
