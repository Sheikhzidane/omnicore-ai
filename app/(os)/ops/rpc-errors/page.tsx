import { Metadata } from 'next';
import { RpcErrorReport } from '@/components/rpc-error-report';

export const metadata: Metadata = {
  title: 'RPC Error Analysis',
  description: 'View and analyze resolved RPC errors classified by type',
};

export default function RpcErrorsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <RpcErrorReport showResolved={true} maxItems={100} />
      </div>
    </div>
  );
}
