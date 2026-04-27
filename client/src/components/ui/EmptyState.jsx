export default function EmptyState({ title, description, action }) {
  return (
    <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center bg-white">
      <p className="text-gray-700 font-medium">{title}</p>
      {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
