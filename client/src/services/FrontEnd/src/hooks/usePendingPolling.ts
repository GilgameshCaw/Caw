import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Hook that polls for pending likes and caws to check if they've been confirmed
 */
export function usePendingPolling(enabled: boolean = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    // Poll every 3 seconds
    const interval = setInterval(() => {
      // Invalidate queries that might have pending items
      // This will cause them to refetch and update the UI

      // Refetch user's caws (for pending caws)
      queryClient.invalidateQueries({
        queryKey: ['caws'],
        refetchType: 'active' // Only refetch if the query is currently active
      });

      // Refetch feed (for pending caws in feed)
      queryClient.invalidateQueries({
        queryKey: ['feed'],
        refetchType: 'active'
      });

      // Refetch likes (for pending likes)
      queryClient.invalidateQueries({
        queryKey: ['likes'],
        refetchType: 'active'
      });

      // Refetch individual caw details (for pending likes/recaws on specific caws)
      queryClient.invalidateQueries({
        queryKey: ['caw'],
        refetchType: 'active'
      });

      console.log('[Polling] Checking for pending items...');
    }, 3000); // Poll every 3 seconds

    return () => clearInterval(interval);
  }, [enabled, queryClient]);
}

/**
 * Hook that polls for a specific pending caw
 */
export function usePendingCawPolling(cawId: number | undefined, isPending: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!cawId || !isPending) return;

    const interval = setInterval(() => {
      // Invalidate the specific caw query
      queryClient.invalidateQueries({
        queryKey: ['caw', cawId],
        refetchType: 'active'
      });

      console.log(`[Polling] Checking pending caw ${cawId}...`);
    }, 3000);

    return () => clearInterval(interval);
  }, [cawId, isPending, queryClient]);
}

/**
 * Hook that polls for pending likes on a specific caw
 */
export function usePendingLikePolling(cawId: number | undefined, hasPendingLike: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!cawId || !hasPendingLike) return;

    const interval = setInterval(() => {
      // Invalidate queries related to this caw's likes
      queryClient.invalidateQueries({
        queryKey: ['caw', cawId],
        refetchType: 'active'
      });

      // Also invalidate the user's likes query
      queryClient.invalidateQueries({
        queryKey: ['likes'],
        refetchType: 'active'
      });

      console.log(`[Polling] Checking pending like for caw ${cawId}...`);
    }, 3000);

    return () => clearInterval(interval);
  }, [cawId, hasPendingLike, queryClient]);
}