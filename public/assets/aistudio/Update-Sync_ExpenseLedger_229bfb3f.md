# Update & Sync Expense Ledger

## Option 1: Bulk Upload of Expense Items

## Inputs:

1) Source file, expense item tracker in CSV format  
2) The Expense ledger Google Sheet, is named “Expense\_Ledger” and the GoogleSheet ID “1cHUFKpyeZNhBuHFx8R2OSZhA9br4Oc1-DNq0w\_IgP2k”

## Tasks:

1. Upload / attach the source file  
2. Ensure each record in the source file has an unique ID  
3. Populate the Expense ledger with each item record from the source file  
4. The mandatory fields of the Expense ledger to be populated are \-  
   1. Exp\_ID this maps to the unique ID in the source file  
   2. Date  
   3. Amount  
   4. Category  
   5. Description  
   6. Status  
5. The optional  fields of the Expense ledger to be populated are \-  
   1. Sub Category  
   2. Puja  
   3. Payment Mode  
   4. Recon Source  
   5. Recon Source ID  
6. Sub Categories are dynamically selectable depending on the Category. The sub category options for a given category, are mapped in the ‘CatSubcat’ tab  
7. The possible values of Category, Status, Puja, Payment Mode are listed in the “LookUp” tab  
8. In the source file, filter only those expense records whose request type is “Actual” and status is “Accepted” or “Paid”  
9. Display the Expense Ledger table in the GUI with the data saved in the Expense Ledger&nbsp;  
10. Each record of the Expense Ledger table should be editable, except for the Unique ID field of the records. After editing in the GUI, it should be saved back in the Expense ledger.  
11. When a new source file is uploaded, make sure to remove duplicate expense item records by comparing the Ids in the source file with those in the Expense ledger.

## Option 2: Manual entry of Expense Items

## Inputs:

1. The Expense ledger Google Sheet, is named “Expense\_Ledger” and the GoogleSheet ID “1cHUFKpyeZNhBuHFx8R2OSZhA9br4Oc1-DNq0w\_IgP2k”

## Tasks:

1. Display an interface to populate the Expense ledger by keying in values of each field.  
2. Generate an unique ID for each record manually populated&nbsp;  
3. The mandatory fields of the Expense ledger to be populated are \-  
   1. Date  
   2. Amount  
   3. Category  
   4. Description  
   5. Status  
4. The optional  fields of the Expense ledger to be populated are \-  
   1. Sub Category  
   2. Puja  
   3. Payment Mode  
   4. Recon Source  
   5. Recon Source ID  
5. The possible values of Category, Status, Puja, Payment Mode are listed in the “LookUp” tab  
6. Sub Categories are dynamically selectable depending on the Category. The sub category options for a given category, are mapped in the ‘CatSubcat’ tab  
7. Each record of the Expense Ledger table should be editable, except for the Unique ID field of the records. After editing in the GUI, it should be saved back in the Expense ledger.  
8. Display the Expense Ledger table in the GUI with the data saved in the Expense Ledger&nbsp;  
9. When a new source file is uploaded, make sure to remove duplicate expense item record by comparing the Ids in the source file with those in the Expense ledger.

&nbsp;