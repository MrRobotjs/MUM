import { PageHeader } from '../components';
import { ServerHistory } from '../components/history/ServerHistory';

// Every play on one server at a time, for any server, with the same table as a
// person's and a server's History tabs.
const HistoryPage = () => (
  <div className="space-y-6">
    <PageHeader title="History" description="What everyone has played across your servers." />
    <ServerHistory description="Everyone’s plays on the selected servers, newest first." />
  </div>
);

export default HistoryPage;
