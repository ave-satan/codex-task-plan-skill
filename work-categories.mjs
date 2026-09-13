// One catalog drives tool validation and the embedded widget icon lookup.
export const workCategories = [
  { id: "research", label: "Исследование", task: "gather facts, sources, compare options" },
  { id: "architecture", label: "Проектирование", task: "design architecture, contracts, component boundaries" },
  { id: "design", label: "Дизайн", task: "visual design, layout, typography, UX" },
  { id: "implementation", label: "Реализация", task: "implement or change application behavior" },
  { id: "diagnostics", label: "Диагностика", task: "reproduce and explain bugs or failures" },
  { id: "testing", label: "Проверка", task: "write/run tests or check acceptance requirements" },
  { id: "review", label: "Ревью", task: "independently critique existing code or decisions" },
  { id: "data", label: "Данные", task: "transform, analyze, import or reconcile datasets" },
  { id: "documentation", label: "Документация", task: "write documentation, guides, explanatory text" },
  { id: "operations", label: "Эксплуатация", task: "configure, deploy, maintain services and infrastructure" },
];

export const workCategoryIds = workCategories.map(({ id }) => id);
