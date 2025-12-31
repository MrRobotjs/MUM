import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StreamingTable } from '../dashboard';

interface StreamingHistoryFiltersProps {
  serviceType: string;
  setServiceType: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  userName: string;
  setUserName: (value: string) => void;
  startDate: string;
  setStartDate: (value: string) => void;
  endDate: string;
  setEndDate: (value: string) => void;
  page: number;
  onFilterChange: () => void;
  onClearFilters: () => void;
  onPageChange: (page: number) => void;
}

export const StreamingHistoryFilters = ({
  serviceType,
  setServiceType,
  status,
  setStatus,
  userName,
  setUserName,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  page,
  onFilterChange,
  onClearFilters,
  onPageChange
}: StreamingHistoryFiltersProps) => {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="text-xl">Streaming Sessions History</CardTitle>
            <CardDescription>Filter and review recent streaming sessions.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">Service</span>
            <Select
              value={serviceType}
              onValueChange={(value) => {
                setServiceType(value);
                onFilterChange();
              }}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder="All Services" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Services</SelectItem>
                <SelectItem value="plex">Plex</SelectItem>
                <SelectItem value="jellyfin">Jellyfin</SelectItem>
                <SelectItem value="emby">Emby</SelectItem>
                <SelectItem value="kavita">Kavita</SelectItem>
                <SelectItem value="audiobookshelf">Audiobookshelf</SelectItem>
                <SelectItem value="komga">Komga</SelectItem>
                <SelectItem value="romm">RomM</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">Status</span>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                onFilterChange();
              }}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">Username</span>
            <Input
              type="text"
              placeholder="Search by username"
              value={userName}
              onChange={(event) => setUserName(event.target.value)}
              className="h-9"
            />
          </div>

          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">Start date</span>
            <Input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="h-9"
            />
          </div>

          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">End date</span>
            <Input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="h-9"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              onFilterChange();
            }}
          >
            Apply
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearFilters}
          >
            Clear
          </Button>
        </div>

        <StreamingTable
          page={page}
          serviceType={serviceType === 'all' ? undefined : serviceType}
          status={status === 'all' ? undefined : status}
          userName={userName || undefined}
          startDate={startDate || undefined}
          endDate={endDate || undefined}
          onPageChange={onPageChange}
        />
      </CardContent>
    </Card>
  );
};
