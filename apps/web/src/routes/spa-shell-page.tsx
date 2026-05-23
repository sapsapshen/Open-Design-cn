import { ClientApp } from '../../app/[[...slug]]/client-app';

export function generateSpaShellStaticParams() {
  return [{ slug: [] }];
}

export function CatchAllPage() {
  return <ClientApp />;
}