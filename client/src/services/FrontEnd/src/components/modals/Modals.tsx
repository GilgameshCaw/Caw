import { useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { Modal, useModalStore } from "~/store";
import { CommentModal } from "~/components/modals/CommentModal";
import QuoteModal   from '~/components/modals/QuoteModal'
import MessageModal from '~/components/modals/MessageModal'
import FollowListModal from '~/components/modals/FollowListModal'


const KEEP_MODALS: Modal[] = ["network", "comment", "quote", "message", "followingList", "followersList"];

export const Modals: React.FC = () => {
  const { modal, modalData, closeModal, onSuccess } = useModalStore();

  // Close modal on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && modal) {
      closeModal();
    }
  }, [modal, closeModal]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (modal && !KEEP_MODALS.includes(modal)) {
      closeModal();
    }
  }, [modal, closeModal]);


  if (modal === "comment")
    return <CommentModal caw={modalData} onClose={closeModal} onReplySubmitted={onSuccess} />
  else if (modal === "quote")
    return <QuoteModal caw={modalData} onClose={closeModal} />
  else if (modal === "message")
    return <MessageModal recipient={modalData} onClose={closeModal} />
  else if (modal === "followingList")
    return <FollowListModal type="following" />
  else if (modal === "followersList")
    return <FollowListModal type="followers" />

  return null;
};
