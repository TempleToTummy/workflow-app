export const REPORTS = [
  { label: "Time Summary", href: "/reports/time-summary" },
  { label: "Project Activity List", href: "/reports/project-activity-list" },
  { label: "Projects Status Summary", href: "/reports/projects-status-summary" },
  { label: "Project Activity Status", href: "/reports/project-activity-status" },
  { label: "Client Activity Matrix", href: "/reports/client-activity-matrix" },
  { label: "Project Summary Matrix", href: "/reports/project-summary-matrix" },
  { label: "Project Task Compare", href: "/reports/project-task-compare" },
  { label: "Project Assigned to Client", href: "/reports/project-assigned-to-client" },
  { label: "Client Information List", href: "/reports/client-information-list" },
];

export const ADMIN_GROUPS = [
  {
    heading: "Project Information",
    items: [
      { label: "Projects", href: "/admin/projects" },
      { label: "Projects Task", href: "/admin/projects-task" },
      { label: "Projects Task Map", href: "/admin/projects-task-map" },
    ],
  },
  {
    heading: "Admin",
    items: [
      { label: "Admin Client Activity", href: "/admin/client-activity" },
      { label: "Accounting Period Information", href: "/admin/accounting-periods" },
      { label: "Work Generation", href: "/admin/scheduler" },
    ],
  },
  {
    heading: "Misc Information",
    items: [
      { label: "Employees", href: "/admin/employees" },
      { label: "Corporate & Business Type", href: "/admin/business-types" },
    ],
  },
];
