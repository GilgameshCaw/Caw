import { useEffect } from "react";
import { Modal, useModalStore } from "~/store";
import { CommentModal } from "~/components/modals/CommentModal";
import QuoteModal   from '~/components/modals/QuoteModal'
import MessageModal from '~/components/modals/MessageModal'
import FollowListModal from '~/components/modals/FollowListModal'
import ComposePostModal from '~/components/modals/ComposePostModal'


const KEEP_MODALS: Modal[] = ["network", "comment", "quote", "message", "post", "followingList", "followersList", "notificationActors"];

export const Modals: React.FC = () => {
  const { modal, modalData, closeModal, onSuccess } = useModalStore();

  useEffect(() => {
    if (modal && !KEEP_MODALS.includes(modal)) {
      closeModal();
    }
  }, [modal, closeModal]);

  // ModalWrapper handles Escape key and click-outside for each modal
  // Only render modals when both isOpen AND data is available
  return (
    <>
      {modal === "comment" && modalData && (
        <CommentModal
          isOpen={true}
          caw={modalData}
          onClose={closeModal}
          onReplySubmitted={onSuccess}
        />
      )}
      {modal === "quote" && modalData && (
        <QuoteModal
          isOpen={true}
          caw={modalData}
          onClose={closeModal}
          onSuccess={() => { onSuccess?.(); closeModal() }}
        />
      )}
      {modal === "message" && modalData && (
        <MessageModal
          isOpen={true}
          recipient={modalData}
          onClose={closeModal}
        />
      )}
      {modal === 'post' && (
        <ComposePostModal
          isOpen={true}
          onClose={closeModal}
        />
      )}
      <FollowListModal type="following" />
      <FollowListModal type="followers" />
      <FollowListModal type="notificationActors" />
    </>
  );
};
