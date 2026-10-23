import type { RecurringType } from "@prisma/client";

// Reference data every installation starts with: the firm's real service
// catalog and its federal deadlines, and the corporation types. Used by the
// demo seed (prisma/seed.ts) and by the production first run
// (prisma/setup.ts), so both start from the same catalog.

export const CORPORATION_TYPES = ["LLC", "S-Corp", "C-Corp", "Sole Proprietor"];

// Deadline rules, as days after the accounting period's end date (see
// Project.dueOffsetDays and src/lib/due-dates.ts). Only federal statutory
// deadlines are filled in here — those are facts, not guesses. Everything else
// is left at 0 (due the last day of the period) for the firm to set on the
// project page, exactly like the four services whose checklists were never
// confirmed: inventing a client's deadline would be worse than leaving it
// visibly unset.
//
// The annual figures are offsets from a Dec 31 year end:
//   Jan 31 = 31, Mar 15 = 74, Apr 15 = 105.
export const DUE_RULES: Record<string, number> = {
  "1099 Form": 31, // federal: recipient + IRS copies due Jan 31
  "Business Tax Return": 74, // federal: calendar-year 1065 / 1120-S due Mar 15
  "Individual Tax Return": 105, // federal: 1040 due Apr 15
  "Tax Return Extension": 105, // an extension has to be filed by the original Apr 15 date
};

// The full service catalog, pulled from the live KTAX app's Project pages
// (name, description, and recurring type match exactly; checklist steps and
// sequence numbers match the ordered task lists shown there). Four services
// (Monthly Financial Report, New Business Registration, Payroll, Quarterly
// Financial Report) had no checklist rows visible in the source app, so they
// exist here as templates with zero steps until real steps are confirmed.
export const PROJECT_CATALOG: {
  name: string;
  description: string;
  recurring: RecurringType;
  steps: { seq: number; name: string }[];
}[] = [
  {
    name: "1099 Form",
    description: "1099 Contractor Form",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Send QuickBooks Contractor report to Client" },
      { seq: 20, name: "Confirm Contractor names and amounts" },
      { seq: 30, name: "Prepare 1099 Forms" },
      { seq: 40, name: "Send 1099 draft to client for review" },
      { seq: 50, name: "Submit / e-file 1099" },
      { seq: 60, name: "Check e-file Acceptance" },
      { seq: 70, name: "Completed Y/N" },
    ],
  },
  {
    name: "Annual Report",
    description: "Annual Report",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Check client credit card on file" },
      { seq: 20, name: "Send email to client for credit card" },
      { seq: 30, name: "File Annual Report to SOS" },
      { seq: 40, name: "Send new report to client" },
      { seq: 50, name: "Completed Y/N" },
    ],
  },
  {
    name: "Bookkeeping",
    description: "For Bookkeeping",
    recurring: "MONTHLY",
    steps: [
      { seq: 10, name: "Document Received" },
      { seq: 20, name: "Data entry" },
      { seq: 30, name: "Bank Reconciliation" },
      { seq: 40, name: "Reviewer Layer 1" },
      { seq: 42, name: "Ask My accountant query" },
      { seq: 50, name: "Reviewer Layer 2" },
      { seq: 60, name: "Report Sent to Client" },
      { seq: 70, name: "Review done by Client" },
      { seq: 80, name: "Completed Y/N" },
    ],
  },
  {
    name: "Business Tax Return",
    description: "Business Tax Return",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Review financial with client and gather all end of year documents" },
      { seq: 20, name: "Enter data in tax return, P&L and Balance sheet" },
      { seq: 30, name: "Review K1, basis of each K1, Schedule L, M" },
      { seq: 40, name: "Review state Return" },
      { seq: 45, name: "Master Review" },
      { seq: 50, name: "Review client bank information" },
      { seq: 60, name: "Send return draft copy to client for review" },
      { seq: 70, name: "Send form 8879 for signature" },
      { seq: 80, name: "Send engagement letter for new and one time clients" },
      { seq: 90, name: "Confirm 8879 signed" },
      { seq: 100, name: "Ready to file tax return" },
      { seq: 110, name: "Confirm federal and state both tax return filed" },
      { seq: 120, name: "Confirm federal and state both tax return accepted" },
    ],
  },
  {
    name: "Individual Tax Return",
    description: "Individual Tax Return",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Received all documents from client" },
      { seq: 20, name: "Enter data and confirm all documents" },
      { seq: 30, name: "Request for any missing documents" },
      { seq: 40, name: "Review with client confirm address and bank info" },
      { seq: 45, name: "Send Draft copy to Client" },
      { seq: 50, name: "Payment Received" },
      { seq: 60, name: "Send form 8879 for signature and return" },
      { seq: 70, name: "Send engagement letter" },
      { seq: 80, name: "Confirm 8879 signed" },
      { seq: 90, name: "Ready to file tax return" },
      { seq: 100, name: "Confirm federal and state both tax return filed" },
      { seq: 110, name: "Confirm federal and state both tax return accepted" },
      { seq: 120, name: "Completed Y/N" },
    ],
  },
  {
    name: "Liquor License Renewal",
    description: "Liquor License Renewal",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Email reminder to client" },
      { seq: 20, name: "City liquor license" },
      { seq: 30, name: "Insurance Copy" },
      { seq: 40, name: "File liquor license" },
      { seq: 50, name: "Email license copy to Client" },
      { seq: 60, name: "Completed Y/N" },
    ],
  },
  {
    name: "Monthly Financial Report",
    description: "Monthly Financial Report Need to send every month",
    recurring: "MONTHLY",
    steps: [],
  },
  {
    name: "New Business Registration",
    description: "New Business Registration.",
    recurring: "ONE_TIME",
    steps: [],
  },
  {
    name: "Payroll",
    description: "Payroll",
    recurring: "MONTHLY",
    steps: [],
  },
  {
    name: "Quarterly Financial Report",
    description: "Quarterly Financial Report Need to send every Quarter",
    recurring: "QUARTERLY",
    steps: [],
  },
  {
    name: "Sales Tax",
    description: "Sales Tax",
    recurring: "MONTHLY",
    steps: [
      { seq: 10, name: "Document Received" },
      { seq: 20, name: "Verify report" },
      { seq: 30, name: "Start calculation and verify" },
      { seq: 40, name: "Start return and verify" },
      { seq: 50, name: "Submit return" },
      { seq: 60, name: "Verify bank and submit payment" },
      { seq: 70, name: "Save return and payment confirmation" },
      { seq: 80, name: "Send Sales return to client" },
      { seq: 90, name: "Record sales journal in QB" },
      { seq: 100, name: "Completed Y/N" },
    ],
  },
  {
    name: "Tax Return Extension",
    description: "Individual and Business Tax Return Extension",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Create Extension" },
      { seq: 20, name: "Submit Extension" },
      { seq: 30, name: "Accepted Extension" },
      { seq: 40, name: "Completed Y/N" },
    ],
  },
  {
    name: "Tobacco License Renewal",
    description: "Tobacco License Renewal",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Email reminder to client" },
      { seq: 20, name: "Submit payment" },
      { seq: 30, name: "Email license copy to Client" },
      { seq: 40, name: "Completed Y/N" },
    ],
  },
];
