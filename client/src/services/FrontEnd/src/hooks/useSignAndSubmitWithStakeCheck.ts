import { useState, useCallback } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { InsufficientStakeError } from '~/errors/InsufficientStakeError'
import type { ActionParams } from '~/api/actions'

export function useSignAndSubmitWithStakeCheck() {
  const signAndSubmit = useSignAndSubmitAction()
  const [stakeError, setStakeError] = useState<{
    isOpen: boolean
    currentAmount?: bigint
    requiredAmount?: bigint
    actionType?: 'post' | 'like' | 'repost'
  }>({
    isOpen: false
  })

  const submitWithStakeCheck = useCallback(async (params: ActionParams) => {
    try {
      const result = await signAndSubmit(params)
      return result
    } catch (error) {
      if (error instanceof InsufficientStakeError) {
        setStakeError({
          isOpen: true,
          currentAmount: error.currentAmount,
          requiredAmount: error.requiredAmount,
          actionType: error.actionType
        })
        throw error // Re-throw so the component knows the action failed
      }
      throw error
    }
  }, [signAndSubmit])

  const closeStakeModal = useCallback(() => {
    setStakeError({ isOpen: false })
  }, [])

  return {
    signAndSubmit: submitWithStakeCheck,
    stakeError,
    closeStakeModal
  }
}