export function LoadingSpinner() {
  return (
    <div className="flex justify-center items-center py-8">
      <div className="relative">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 border-t-blue-600"></div>
      </div>
    </div>
  );
}

