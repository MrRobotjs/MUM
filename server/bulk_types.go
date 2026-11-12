package main

type bulkOperationInput struct {
	Action              string   `json:"action"`
	Days                int      `json:"days,omitempty"`
	ExpiresAt           *string  `json:"expires_at,omitempty"`
	LibraryIDs          []string `json:"library_ids,omitempty"`
	HasAllLibraries     bool     `json:"has_all_libraries,omitempty"`
	TargetLocalUserUUID string   `json:"target_local_user_uuid,omitempty"`
}

type bulkReceipt struct {
	ID       string           `json:"id"`
	Revision string           `json:"revision"`
	State    string           `json:"state"`
	Action   string           `json:"action"`
	Results  []bulkUserResult `json:"results"`
	Summary  map[string]int   `json:"summary"`
	Warnings []string         `json:"warnings"`
	Effects  []string         `json:"effects"`
}
