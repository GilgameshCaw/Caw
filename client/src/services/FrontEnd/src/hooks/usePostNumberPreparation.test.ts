import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { usePostNumberPreparation } from './usePostNumberPreparation'

it('shows checking while the existing allocator runs and returns the allocated numbers', async () => {
  let resolve!: (value: number[]) => void
  const pending = new Promise<number[]>(done => { resolve = done })
  const allocate = vi.fn(() => pending)
  const { result } = renderHook(() => usePostNumberPreparation(allocate))
  let submission!: Promise<number[] | null>

  act(() => { submission = result.current.prepare(17, 2) })
  expect(result.current.status).toBe('checking')
  expect(allocate).toHaveBeenCalledExactlyOnceWith(17, 2)

  await act(async () => {
    resolve([714, 715])
    expect(await submission).toEqual([714, 715])
  })
  expect(result.current.status).toBe('idle')
})

it('keeps a failed check visible and gates submission until a later attempt succeeds', async () => {
  const allocate = vi.fn()
    .mockRejectedValueOnce(new Error('RPC unavailable'))
    .mockResolvedValueOnce([714])
  const { result } = renderHook(() => usePostNumberPreparation(allocate))
  const submit = vi.fn()
  const attempt = async () => {
    const numbers = await result.current.prepare(17, 1)
    if (numbers) submit(numbers)
  }

  await act(attempt)
  expect(result.current.status).toBe('failed')
  expect(submit).not.toHaveBeenCalled()

  await act(attempt)
  expect(submit).toHaveBeenCalledExactlyOnceWith([714])
  expect(result.current.status).toBe('idle')
})
