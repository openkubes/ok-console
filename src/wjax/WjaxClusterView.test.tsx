import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WjaxClusterView from './WjaxClusterView'

const sample = (replicas = 2) => ({
  cluster: 'kind-wjax-demo', namespace: 'wjax-demo', mode: 'read-only-live',
  deployments: [{ name: 'wjax-nginx', desired: replicas, ready: replicas }],
  pods: replicas ? [{ name: 'wjax-nginx-pod', phase: 'Running', ready: true, restarts: 3 }] : [],
})
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('W-JAX read-only Kubernetes observations', () => {
  it('observes 2/2 → 0/0 with empty Pods → recovered 2/2 via explicit GET refresh', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(sample()))
      .mockResolvedValueOnce(response(sample(0))).mockResolvedValueOnce(response(sample()))
    vi.stubGlobal('fetch', fetcher)
    render(<WjaxClusterView/>)
    expect(await screen.findByText('2/2')).toBeInTheDocument()
    const pods = within(screen.getByRole('table', { name: 'Pods' }))
    expect(pods.getByText('wjax-nginx-pod')).toBeInTheDocument()
    expect(pods.getByText('Running')).toBeInTheDocument()
    expect(pods.getByText('Yes')).toBeInTheDocument()
    expect(pods.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/Last successful observation/).querySelector('time')?.dateTime).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open Agentic Operations demo/ })).toHaveAttribute('href', 'http://127.0.0.1:8788/')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observation' }))
    expect(await screen.findByText('0/0')).toBeInTheDocument()
    expect(screen.getByText('No Pods observed in wjax-demo.')).toBeInTheDocument()
    expect(screen.queryByText('wjax-nginx-pod')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observation' }))
    expect(await screen.findByText('2/2')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe('/api/wjax-kind/snapshot')
      expect(options).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error' })
      expect(options).not.toHaveProperty('headers')
    }
  })

  it('clears prior values during refresh and on failure; keeps only the historical success timestamp', async () => {
    let finish!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(sample())).mockReturnValueOnce(pending)
      .mockResolvedValueOnce(response(sample())))
    render(<WjaxClusterView/>)
    await screen.findByText('2/2')
    const at = screen.getByText(/Last successful observation/).querySelector('time')?.dateTime
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observation' }))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh observation' })).toBeDisabled()
    await act(async () => finish(response({ error: 'SECRET_CREDENTIAL_MUST_NOT_RENDER' }, false)))
    expect(await screen.findByRole('alert')).toHaveTextContent('Reader unavailable')
    expect(screen.queryByText('2/2')).not.toBeInTheDocument()
    expect(screen.queryByText('SECRET_CREDENTIAL_MUST_NOT_RENDER')).not.toBeInTheDocument()
    expect(screen.getByText(/Last successful observation/).querySelector('time')?.dateTime).toBe(at)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observation' }))
    expect(await screen.findByText('2/2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    { ...sample(), cluster: 'other-cluster' },
    { ...sample(), namespace: 'default' },
    { ...sample(), mode: 'fixture' },
    { ...sample(), deployments: [{ name: 'bad', desired: -1, ready: 0 }] },
    { ...sample(), pods: [{ name: 'bad', phase: 'Running', ready: 'yes', restarts: 0 }] },
    { ...sample(), pods: null },
  ])('fails closed on an invalid or foreign Reader response %#', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)))
    render(<WjaxClusterView/>)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText(/None yet/)).toBeInTheDocument()
  })

  it('renders empty Deployment and Pod lists explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...sample(), deployments: [], pods: [] })))
    render(<WjaxClusterView/>)
    expect(await screen.findByText('No Deployments observed in wjax-demo.')).toBeInTheDocument()
    expect(screen.getByText('No Pods observed in wjax-demo.')).toBeInTheDocument()
  })

  it('handles network errors without rendering raw error contents', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('SECRET_CREDENTIAL_MUST_NOT_RENDER')))
    render(<WjaxClusterView/>)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/SECRET_CREDENTIAL/)).not.toBeInTheDocument()
  })

  it('times out a hung Reader request and permits a manual retry', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    render(<WjaxClusterView/>)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh observation' })).toBeEnabled()
  })

  it('aborts the Reader request on unmount', async () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const view = render(<WjaxClusterView/>)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
  })
})
