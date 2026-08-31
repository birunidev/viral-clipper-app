import { create } from "zustand";
import { produce } from "immer";
import type { EditPlan } from "../../../src/services/editPlan.js";
import { createDefaultEditPlan } from "../../../src/services/editPlan.js";

type Store = {
  editPlan: EditPlan | null;
  original: EditPlan | null;
  selectedId: string | null;
  dirty: boolean;
  patch: (fn: (draft: EditPlan) => void) => void;
  load: (plan: EditPlan) => void;
  reset: () => void;
  setSelected: (id: string | null) => void;
};

export const useEditPlanStore = create<Store>((set, get) => ({
  editPlan: null,
  original: null,
  selectedId: null,
  dirty: false,
  patch: (fn) =>
    set((s) => {
      if (!s.editPlan) return s;
      const next = produce(s.editPlan, fn);
      return { editPlan: next, dirty: true };
    }),
  load: (plan) => set({ editPlan: plan, original: structuredClone(plan), dirty: false }),
  reset: () => {
    const { original } = get();
    if (original) set({ editPlan: structuredClone(original), dirty: false });
  },
  setSelected: (id) => set({ selectedId: id }),
}));

// helper to create default plan for project
export function ensurePlan(projectId: string, duration: number): EditPlan {
  return createDefaultEditPlan(projectId, duration);
}
