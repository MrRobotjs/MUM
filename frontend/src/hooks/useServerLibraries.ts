import useSWR from "swr"

import { requestJson } from "@/util/apiClient"

export type ServerLibrary = {
  id: number
  name: string
  library_type?: string | null
}

type ServerLibrariesResponse = {
  data: ServerLibrary[]
}

type UseServerLibrariesOptions = {
  enabled?: boolean
}

export const useServerLibraries = (
  serverId?: number,
  options: UseServerLibrariesOptions = {}
) => {
  const enabled = options.enabled ?? true
  const key =
    enabled && serverId
      ? `/api/v2/libraries?server_id=${serverId}&include_server=false`
      : null

  const { data, error, isLoading, mutate } = useSWR<ServerLibrariesResponse>(
    key,
    (url: string) => requestJson(url),
    {
      revalidateOnFocus: false,
    }
  )

  const hasLoaded = Boolean(data) || Boolean(error)

  return {
    libraries: data?.data ?? [],
    loading: Boolean(enabled && isLoading),
    error,
    refresh: mutate,
    hasLoaded,
  }
}
