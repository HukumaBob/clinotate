interface JobErrorNoticeProps {
  message: string;
  onDismiss: () => void;
}

export function JobErrorNotice({ message, onDismiss }: JobErrorNoticeProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200"
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="rounded px-2 py-0.5 text-red-300 hover:bg-red-900"
      >
        ✕
      </button>
    </div>
  );
}
