import { create } from "zustand";

export type Modal = "network" | 'comment' | 'quote';

interface ModalStore {
  modal?: Modal;
  openModal: (modal: Modal) => void;
  closeModal: () => void;
  modalData?: any;
}


interface ModalActions {
 openModal: (m: Modal, data?: any) => void
 closeModal: () => void
}

export const useModalStore = create<ModalStore>((set) => ({
  openModal: (modal: Modal, data?: any) => set({ modal: modal, modalData: data }),
  closeModal: () => set({ modal: undefined }),
  modalData: undefined,
}));
