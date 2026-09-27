import styles from "./Toast.module.css";

/** DS classes for every sonner toast part; the DS Toaster applies them. */
export const toastClassNames = {
  toast: styles.toast,
  title: styles.title,
  description: styles.description,
  closeButton: styles.closeButton,
  actionButton: styles.actionButton,
  cancelButton: styles.cancelButton,
  success: styles.success,
  warning: styles.warning,
  error: styles.error,
} as const;
