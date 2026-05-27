# Dispatch radius constants used by the dispatch task.
#
# Strategy: try all candidates at INITIAL_RADIUS_KM first.
# If the list is exhausted without an assignment, re-query at EXPANDED_RADIUS_KM.
# If still no driver, cancel the ride.

INITIAL_RADIUS_KM = 3.0
EXPANDED_RADIUS_KM = 5.0

# Radii tried in order. Extending this list adds more expansion stages.
DISPATCH_RADII = [INITIAL_RADIUS_KM, EXPANDED_RADIUS_KM]
