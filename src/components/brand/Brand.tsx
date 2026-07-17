import { cn } from '@/lib/cn';

export function YakMark({ className, alt = 'Yak' }: { className?: string; alt?: string }) {
  return <img className={cn('yak-mark', className)} src="/yak.svg" alt={alt} />;
}

export function YakitMark({ className }: { className?: string }) {
  return <img className={cn('yakit-mark', className)} src="/icon/yakitlogo.png" alt="Yakit" />;
}

export function ProductBrand({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn('product-brand', compact && 'product-brand--compact', className)}>
      <span className="product-brand__art"><YakMark /></span>
      <span className="product-brand__copy">
        <strong>Yakit Browser Agent</strong>
        {!compact && <small>Authenticated browser security workspace</small>}
      </span>
    </div>
  );
}
