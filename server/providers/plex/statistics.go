package plex

import (
	"context"
	"encoding/xml"
	"errors"
	"math"
	"net/url"
	"strconv"
	"time"

	"app/server/providers/provider"
)

// Server dashboard statistics: the bandwidth and resource graphs on Plex
// Web's Status → Dashboard. Plex does not document these routes; plexapi
// (Tautulli, Flask) reads them as /statistics/bandwidth and
// /statistics/resources with the server owner's token.

// bandwidthTimespans are Plex's bin sizes.
var bandwidthTimespans = map[string]string{"seconds": "6", "hours": "4", "days": "3", "weeks": "2", "months": "1"}

// BandwidthTimespan reports whether span is one Plex's bandwidth statistics
// accept.
func BandwidthTimespan(span string) bool { _, ok := bandwidthTimespans[span]; return ok }

type statisticsContainer struct {
	XMLName   xml.Name `xml:"MediaContainer"`
	Bandwidth []struct {
		Account string `xml:"accountID,attr"`
		Device  string `xml:"deviceID,attr"`
		At      *int64 `xml:"at,attr"`
		LAN     string `xml:"lan,attr"`
		Bytes   *int64 `xml:"bytes,attr"`
	} `xml:"StatisticsBandwidth"`
	Resources []struct {
		At            *int64   `xml:"at,attr"`
		HostCPU       *float64 `xml:"hostCpuUtilization,attr"`
		ProcessCPU    *float64 `xml:"processCpuUtilization,attr"`
		HostMemory    *float64 `xml:"hostMemoryUtilization,attr"`
		ProcessMemory *float64 `xml:"processMemoryUtilization,attr"`
	} `xml:"StatisticsResources"`
	Accounts []struct {
		ID   string `xml:"id,attr"`
		Name string `xml:"name,attr"`
	} `xml:"Account"`
	Devices []struct {
		ID   string `xml:"id,attr"`
		Name string `xml:"name,attr"`
	} `xml:"Device"`
}

// statisticsMaxSamples bounds one statistics answer.
const statisticsMaxSamples = 20000

func (s *Server) statistics(ctx context.Context, path string) (statisticsContainer, error) {
	var page statisticsContainer
	body, err := s.Read(ctx, path, 16<<20)
	if err != nil {
		return page, err
	}
	if err := strictXML(body); err != nil {
		return page, err
	}
	if err := xml.Unmarshal(body, &page); err != nil {
		return page, errors.New("invalid Plex statistics")
	}
	if len(page.Bandwidth) > statisticsMaxSamples || len(page.Resources) > statisticsMaxSamples || len(page.Accounts) > statisticsMaxSamples || len(page.Devices) > statisticsMaxSamples {
		return page, errors.New("Plex statistics are too large")
	}
	return page, nil
}

func statisticsTime(at *int64) (time.Time, bool) {
	if at == nil || *at < 0 || *at > 253402300799 {
		return time.Time{}, false
	}
	return time.Unix(*at, 0).UTC(), true
}

// optionalID accepts an absent or numeric account/device ID.
func optionalID(id string) bool { return id == "" || id == "0" || NumericID(id) }

// Bandwidth reads the server's bandwidth samples in one of Plex's bin sizes,
// from since onwards when it is set (Plex's "at>" filter), with the names of
// the accounts and devices they belong to when Plex lists them. Any malformed
// sample rejects the whole answer.
func (s *Server) Bandwidth(ctx context.Context, timespan string, since time.Time) (provider.BandwidthStatistics, error) {
	var out provider.BandwidthStatistics
	code, ok := bandwidthTimespans[timespan]
	if !ok {
		return out, errors.New("unsupported Plex bandwidth timespan")
	}
	query := url.Values{"timespan": {code}}
	if !since.IsZero() {
		query.Set("at>", strconv.FormatInt(since.Unix(), 10))
	}
	page, err := s.statistics(ctx, "/statistics/bandwidth?"+query.Encode())
	if err != nil {
		return out, err
	}
	out.Samples = make([]provider.BandwidthSample, 0, len(page.Bandwidth))
	for _, row := range page.Bandwidth {
		at, ok := statisticsTime(row.At)
		if !ok || row.Bytes == nil || *row.Bytes < 0 || !optionalID(row.Account) || !optionalID(row.Device) || row.LAN != "" && row.LAN != "0" && row.LAN != "1" {
			return out, errors.New("invalid Plex bandwidth sample")
		}
		out.Samples = append(out.Samples, provider.BandwidthSample{At: at, Bytes: *row.Bytes, LAN: row.LAN == "1", Account: row.Account, Device: row.Device})
	}
	for _, a := range page.Accounts {
		if NumericID(a.ID) || a.ID == "0" {
			out.Accounts = append(out.Accounts, provider.Named{ID: a.ID, Name: provider.TruncateRunes(a.Name, 256)})
		}
	}
	for _, d := range page.Devices {
		if NumericID(d.ID) {
			out.Devices = append(out.Devices, provider.Named{ID: d.ID, Name: provider.TruncateRunes(d.Name, 256)})
		}
	}
	return out, nil
}

// Resources reads the server's recent CPU and memory samples (Plex keeps only
// a short real-time window). A percentage Plex leaves out stays unknown.
func (s *Server) Resources(ctx context.Context) ([]provider.ResourceSample, error) {
	page, err := s.statistics(ctx, "/statistics/resources?timespan=6")
	if err != nil {
		return nil, err
	}
	percent := func(v *float64) (*float64, bool) {
		if v == nil {
			return nil, true
		}
		if math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0 || *v > 10000 {
			return nil, false
		}
		value := *v
		return &value, true
	}
	out := make([]provider.ResourceSample, 0, len(page.Resources))
	for _, row := range page.Resources {
		at, ok := statisticsTime(row.At)
		hostCPU, a := percent(row.HostCPU)
		processCPU, b := percent(row.ProcessCPU)
		hostMemory, c := percent(row.HostMemory)
		processMemory, d := percent(row.ProcessMemory)
		if !ok || !a || !b || !c || !d {
			return nil, errors.New("invalid Plex resource sample")
		}
		out = append(out, provider.ResourceSample{At: at, HostCPU: hostCPU, ProcessCPU: processCPU, HostMemory: hostMemory, ProcessMemory: processMemory})
	}
	return out, nil
}
