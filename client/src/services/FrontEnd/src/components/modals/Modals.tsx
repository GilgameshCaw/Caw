import { useEffect } from "react";
import { useAccount } from "wagmi";
import { Modal, useModalStore } from "~/store";
import { CommentModal } from "~/components/modals/CommentModal";
import QuoteModal   from '~/components/modals/QuoteModal'


const KEEP_MODALS: Modal[] = ["network", "comment", "quote"];

export const Modals: React.FC = () => {
  const { modal, modalData, closeModal } = useModalStore();

  useEffect(() => {
    if (modal && !KEEP_MODALS.includes(modal)) {
      closeModal();
    }
  }, [modal, closeModal]);


  if (modal === "comment")
    return <CommentModal caw={modalData} onClose={closeModal} />
  else if (modal === "quote")   return <QuoteModal caw={modalData}   />


  return null;
};
