import { create } from "zustand";

export type Modal = "network" | 'comment' | 'quote' | 'message' | 'followingList' | 'followersList';

interface ModalStore {
  modal?: Modal;
  openModal: (modal: Modal, data?: any, onSuccess?: () => void) => void;
  closeModal: () => void;
  modalData?: any;
  onSuccess?: () => void;
}


interface ModalActions {
 openModal: (m: Modal, data?: any, onSuccess?: () => void) => void
 closeModal: () => void
}

export const useModalStore = create<ModalStore>((set) => ({
  openModal: (modal: Modal, data?: any, onSuccess?: () => void) => set({ modal: modal, modalData: data, onSuccess }),
  closeModal: () => set({ modal: undefined, onSuccess: undefined }),
  modalData: undefined,
  onSuccess: undefined,
}));
