export function LoadingSpinner() {
  return (
    <div className="flex flex-col justify-center items-center py-8 gap-4">
      {/* Aave 风格渐变加载动画 */}
      <div className="relative">
        <div className="aave-spinner"></div>
        {/* 发光效果 */}
        <div className="absolute inset-0 rounded-full bg-aave-purple/20 blur-xl animate-pulse-slow"></div>
      </div>
      <div className="text-aave-text-secondary text-sm font-medium animate-pulse">
        加载中...
      </div>
    </div>
  );
}

