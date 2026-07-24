export default function EmptyState({ title, description, action }) {
  return (
    <div className="border dark:border-gray-700 border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center bg-white dark:bg-gray-800">
      <p className="text-gray-700 dark:text-gray-300 font-medium">{title}</p>
      {description && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
