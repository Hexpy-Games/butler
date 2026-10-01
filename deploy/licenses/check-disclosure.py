"""Offline attribution extraction fixtures."""
from disclosure import copyrights

# test-category: pure-logic
assert copyrights(["Copyright Mozilla Foundation\n\nPermission is hereby granted"]) == ["Copyright Mozilla Foundation"]
assert copyrights(["Copyright JS Foundation and other contributors, https://js.foundation/"]) == ["Copyright JS Foundation and other contributors, https://js.foundation/"]
assert copyrights(["Copyright (c) 2023\n  - Example Author.\n\nPermission is hereby granted"]) == ["Copyright (c) 2023", "- Example Author."]
assert copyrights(["Copyright 2001-2023 Xiph.Org,\n    Jean-Marc Valin,\n    Timothy B. Terriberry\n\nRedistribution..."]) == ["Copyright 2001-2023 Xiph.Org,", "Jean-Marc Valin,", "Timothy B. Terriberry"]
assert copyrights(["Copyright [yyyy] [name of copyright owner]\nThe above copyright notice must remain"]) == []
assert copyrights(["Copyright Holder may include your modifications in the Standard"]) == []
print("Dated, undated and wrapped attribution fixtures passed")
