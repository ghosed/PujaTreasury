**Check Scanner & Recording the scanned check**

It should be able to scan images or PDFs of checks. The images or PDFs could be of multiple checks.  Provide a provision to upload these images or PDF files.

After scanning each check copy, extract the -

1. check number, 
2. bank, 
3. date, 
4. amount, 
5. paid to, 
6. paid by from the top left corner and 
7. the "memo" or "for" from the bottom left corner 

and write them into the Google Sheet named "Check_Ledger" and ID is "1QsvwQevsqxk6f-9l-UKt1OUUjTScn116nI1VJQ31smc". 

Add columns `Transaction Type` and `Is_Recon`.

If the check is paid by Houston Durgabari Society, the `Transaction Type` is "Expense" otherwise, "Income".

For each check recorded, create an unique ID in column A that is the combination of check number, bank and date.

If there are duplicate check copies in the uploaded images or PDFs, don't record them.

Have a button to refresh the GUI with records in the Check_Ledger. 