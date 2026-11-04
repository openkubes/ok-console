import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UserProjectManagement from './UserProjectManagement'

const add = (username = 'developer01') => {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
  fireEvent.click(screen.getByRole('button', { name: 'Add preview user' }))
}
const users = () => within(screen.getByRole('region', { name: 'Preview users table' }))
const assignments = () => within(screen.getByRole('region', { name: 'Proposed assignments table' }))
afterEach(() => vi.restoreAllMocks())

describe('Identity & access preview', () => {
  it('uses neutral branding and explains the empty, simulated sections', () => {
    const { container } = render(<UserProjectManagement/>)
    for (const name of ['Preview users', 'Project planning', 'Proposed access', 'No preview users yet', 'No proposed assignments']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    }
    expect(screen.getByLabelText('Preview boundaries')).toHaveTextContent(/reset on reload or when you leave/)
    expect(screen.getByLabelText('Preview boundaries')).toHaveTextContent(/No accounts, authentication, credentials, Kubernetes RBAC or Developer Workspace access/)
    expect(screen.getByText(/Projects are not connected/)).toBeInTheDocument()
    expect(container).not.toHaveTextContent(/W-JAX|OK-214|Local demo|kind-wjax|wjax-demo|\bActive\b/i)
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('creates, disables, enables and removes an in-memory proposal without network or storage writes', () => {
    const request = vi.spyOn(globalThis, 'fetch')
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const { unmount } = render(<UserProjectManagement/>)
    fireEvent.change(screen.getByLabelText('Example namespace'), { target: { value: 'developer-workspaces' } })
    fireEvent.change(screen.getByLabelText('Proposed role'), { target: { value: 'Editor' } })
    add('  alice  ')
    expect(users().getByRole('rowheader', { name: 'alice' })).toBeInTheDocument()
    expect(assignments().getByRole('row', { name: /alice developer-workspaces Editor Proposed/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No account or access was created.')
    expect(screen.getByLabelText('Username')).toHaveFocus()
    fireEvent.click(users().getByRole('button', { name: 'Disable alice in preview' }))
    expect(users().getByText('Disabled in preview')).toBeInTheDocument()
    expect(assignments().getByText('Paused in preview')).toBeInTheDocument()
    fireEvent.click(users().getByRole('button', { name: 'Enable alice in preview' }))
    expect(assignments().getByText('Proposed')).toBeInTheDocument()
    // Same tick additions must retain independent identifiers and actions.
    add('bob')
    fireEvent.click(users().getByRole('button', { name: 'Remove alice from preview' }))
    expect(assignments().queryByRole('rowheader', { name: 'alice' })).not.toBeInTheDocument()
    expect(assignments().getByRole('rowheader', { name: 'bob' })).toBeInTheDocument()
    fireEvent.click(users().getByRole('button', { name: 'Remove bob from preview' }))
    expect(screen.getByRole('heading', { name: 'No proposed assignments' })).toBeInTheDocument()
    add('charlie')
    unmount()
    render(<UserProjectManagement/>)
    expect(screen.queryByRole('rowheader', { name: 'charlie' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No preview users yet' })).toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  })

  it.each(['', '  ', 'ab', '1alice', 'a b', '<script>', 'a'.repeat(33)])('rejects invalid username %j with a linked, focused error', (name) => {
    render(<UserProjectManagement/>)
    add(name)
    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent('Use 3–32')
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Username')).toHaveAccessibleDescription(expect.stringContaining(error.textContent!))
    expect(screen.getByLabelText('Username')).toHaveFocus()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('rejects case-insensitive duplicates, clears validation on edit and allows reuse after removal', () => {
    render(<UserProjectManagement/>)
    add('Alice')
    add(' alice ')
    expect(screen.getByRole('alert')).toHaveTextContent('already exists')
    expect(users().getAllByRole('rowheader')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(users().getByRole('button', { name: 'Remove Alice from preview' }))
    add('alice')
    expect(users().getAllByRole('rowheader')).toHaveLength(1)
  })
})
