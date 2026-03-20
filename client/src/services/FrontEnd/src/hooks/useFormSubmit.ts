import { useState, useCallback } from 'react'

interface UseFormSubmitOptions {
  onSuccess?: () => void
  onError?: (error: string) => void
}

interface UseFormSubmitReturn {
  isSubmitting: boolean
  error: string | null
  submitted: boolean
  setError: (error: string | null) => void
  clearError: () => void
  handleSubmit: (fn: () => Promise<void>) => Promise<void>
  reset: () => void
}

export function useFormSubmit(options?: UseFormSubmitOptions): UseFormSubmitReturn {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const clearError = useCallback(() => setError(null), [])

  const handleSubmit = useCallback(async (fn: () => Promise<void>) => {
    setIsSubmitting(true)
    setError(null)

    try {
      await fn()
      setSubmitted(true)
      options?.onSuccess?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred'
      setError(message)
      options?.onError?.(message)
    } finally {
      setIsSubmitting(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.onSuccess, options?.onError])

  const reset = useCallback(() => {
    setIsSubmitting(false)
    setError(null)
    setSubmitted(false)
  }, [])

  return { isSubmitting, error, submitted, setError, clearError, handleSubmit, reset }
}
